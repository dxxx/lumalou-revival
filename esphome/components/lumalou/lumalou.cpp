#include "lumalou.h"

#include <cstring>

#include <esp_random.h>
#include <mbedtls/aes.h>
#include <mbedtls/ecdh.h>
#include <mbedtls/ecp.h>

#include "esphome/core/hal.h"
#include "esphome/core/helpers.h"
#include "esphome/core/log.h"

namespace esphome::lumalou {

static const char *const TAG = "lumalou";

static const espbt::ESPBTUUID SERVICE = espbt::ESPBTUUID::from_raw("4cea0001-c678-4202-b5d3-712dbb5e5b14");
static const espbt::ESPBTUUID CH_TX = espbt::ESPBTUUID::from_raw("4cea0002-c678-4202-b5d3-712dbb5e5b14");
static const espbt::ESPBTUUID CH_RX = espbt::ESPBTUUID::from_raw("4cea0003-c678-4202-b5d3-712dbb5e5b14");
static const espbt::ESPBTUUID CH_FACTORY = espbt::ESPBTUUID::from_raw("4cea0004-c678-4202-b5d3-712dbb5e5b14");
static const espbt::ESPBTUUID CH_SESSION = espbt::ESPBTUUID::from_raw("4cea0005-c678-4202-b5d3-712dbb5e5b14");

static const uint32_t TX_GAP_MS = 150;        // between packets
static const uint32_t REFRESH_MS = 60 * 1000;  // re-read state now and then (the lamp also pushes changes)

// CRC-8, polynomial 0x07, start 0xFF (standard CRC-8 table)
static uint8_t crc8(const uint8_t *d, size_t n, uint8_t crc = 0xFF) {
  while (n--) {
    crc ^= *d++;
    for (int i = 0; i < 8; i++)
      crc = (crc & 0x80) ? (uint8_t) ((crc << 1) ^ 0x07) : (uint8_t) (crc << 1);
  }
  return crc;
}

static void aes_ctr(const uint8_t key[16], const uint8_t iv[16], uint8_t *buf, size_t n) {
  mbedtls_aes_context ctx;
  mbedtls_aes_init(&ctx);
  mbedtls_aes_setkey_enc(&ctx, key, 128);
  uint8_t counter[16], stream[16];
  memcpy(counter, iv, 16);
  size_t off = 0;
  mbedtls_aes_crypt_ctr(&ctx, n, &off, counter, stream, buf, buf);
  mbedtls_aes_free(&ctx);
}

static int rng(void *, unsigned char *buf, size_t len) {
  esp_fill_random(buf, len);
  return 0;
}

void Lumalou::setup() {}

void Lumalou::dump_config() {
  ESP_LOGCONFIG(TAG, "Fisher-Price Lumalou (MPID over BLE)");
}

void Lumalou::reset_() {
  this->ready_ = false;
  this->tx_handle_ = this->rx_handle_ = this->factory_handle_ = this->session_handle_ = 0;
  this->tx_queue_.clear();
  this->rx_buf_.clear();
  this->seq_ = 0;
  this->color_ = this->brightness_ = this->volume_ = -1;
  this->global_hex_.clear();
  this->g_ = Global{};
  this->date_hms_ = this->date_wd_ = -1;
  for (int d = 0; d < 7; d++) {
    this->sleepy_[d] = this->r2r_[d] = this->routine_start_[d] = -2;
    this->alarm_[d] = -1;
    this->routine_tasks_[d].clear();
    this->routine_known_[d] = false;
  }
  this->task_step_ = -1;
  for (int &s : this->task_status_)
    s = -1;
  this->clock_on_ = this->clock_brightness_ = this->clock_24h_ = -1;
  this->playlist_.clear();
  this->date_set_ = false;
  this->changes_++;
}

// ---- helpers for the decoded state ---------------------------------------------------------------------------

static int bcd(uint8_t b) { return b > 0x99 ? -1 : (b >> 4) * 10 + (b & 0x0F); }
static uint8_t to_bcd(int v) { return (uint8_t) (((v / 10) << 4) | (v % 10)); }

// 7 x (HH MM) BCD, Sun..Sat; FF FF = none. Minutes since midnight or -1. Whole block 0 = all unset.
static void parse_week_times(const uint8_t *a, size_t n, int out[7]) {
  int sum = 0;
  for (size_t i = 0; i < n && i < 14; i++)
    sum += a[i];
  for (int d = 0; d < 7; d++) {
    int h = n >= 14 ? bcd(a[2 * d]) : -1, m = n >= 14 ? bcd(a[2 * d + 1]) : -1;
    out[d] = (sum == 0 || h < 0 || m < 0 || h > 23 || m > 59) ? -1 : h * 60 + m;
  }
}

static std::string hhmm(int minutes) {
  if (minutes == -2)
    return "null";
  if (minutes < 0)
    return "\"\"";
  return str_sprintf("\"%02d:%02d\"", minutes / 60, minutes % 60);
}

void Lumalou::send_hex(const std::string &hex) {
  std::vector<uint8_t> b;
  int hi = -1;
  for (char c : hex) {
    int v = (c >= '0' && c <= '9') ? c - '0' : (c >= 'a' && c <= 'f') ? c - 'a' + 10 : (c >= 'A' && c <= 'F') ? c - 'A' + 10 : -1;
    if (v < 0) {
      if (hi >= 0) { b.push_back(hi); hi = -1; }  // a lone digit before a separator = one byte
      continue;
    }
    if (hi < 0) hi = v; else { b.push_back((hi << 4) | v); hi = -1; }
  }
  if (hi >= 0)
    b.push_back(hi);
  if (b.empty() || b.size() > 32)
    return;
  ESP_LOGI(TAG, "Page command %s", format_hex_pretty(b.data(), b.size()).c_str());
  this->command_(b);
  // read back what the setter changed, so the page sees the lamp's real state
  const uint8_t op = b[0];
  if (op >= 0x5A && op <= 0x66 && (op % 2) == 0) this->command_({(uint8_t) (op + 1)});  // set{Day}Routine
  switch (op) {
    case 0x48: this->command_({0x49}); break;
    case 0x46: this->command_({0x47}); break;
    case 0x4A: this->command_({0x4C}); break;
    case 0x44: case 0x4D: case 0x58: case 0x77: case 0x6C: case 0x42: case 0x03: case 0x7B:
      this->command_({OP_REQ_GLOBAL_STATE}); break;
    case 0x6B: this->command_({0x68}); this->command_({OP_REQ_GLOBAL_STATE}); break;
    case 0x79: this->command_({0x7A}); this->command_({OP_REQ_GLOBAL_STATE}); break;
    case 0x40: this->command_({0x41}); break;
    case 0x30: this->command_({0x31}); break;
    default: break;
  }
}

void Lumalou::set_date(int hour, int minute, int second, int weekday) {
  if (!this->ready_)
    return;
  this->command_({0x30, to_bcd(hour), to_bcd(minute), to_bcd(second), to_bcd(weekday)});
  this->command_({0x31});
  this->date_set_ = true;
  ESP_LOGI(TAG, "Lamp clock set to %02d:%02d:%02d, weekday %d", hour, minute, second, weekday);
}

void Lumalou::fetch_all() {
  // the app's fetchProperties order, plus clock settings and our single-value reads
  this->command_({0x34});                              // sendPairingComplete
  this->refresh();                                     // global state, colour, brightness, volume
  this->command_({0x31});                              // current date
  this->command_({OP_REQ_FW});
  this->command_({0x41});                              // playlist
  this->command_({0x47});                              // R2R (wake) times
  this->command_({0x49});                              // sleepy times
  this->command_({0x4C});                              // R2R alarms
  this->command_({0x68});                              // routine task status
  for (uint8_t op : {0x5D, 0x5F, 0x61, 0x63, 0x65, 0x67, 0x5B})  // day routines Mon..Sat, Sun
    this->command_({op});
  this->command_({0x7A});                              // clock settings
}

// ---- sunrise wake light ------------------------------------------------------------------------------------

// progress 0..1 -> 9 steps: red 1-3, orange 4-6, yellow 7-9 (colour numbers: 1 red, 3 orange, 2 yellow)
void Lumalou::sunrise_apply_(float progress) {
  int step = std::min(8, std::max(0, (int) (progress * 9)));
  if (step == this->sunrise_step_ || !this->ready_)
    return;
  static const uint8_t COLOUR[3] = {1, 3, 2};
  const uint8_t colour = COLOUR[step / 3];
  const uint8_t bright = step + 1;
  if (this->sunrise_step_ < 0 || step / 3 != this->sunrise_step_ / 3)
    this->set_color(colour);
  this->set_brightness(bright);
  ESP_LOGI(TAG, "Sunrise %d%%: colour %u, brightness %u", (int) (progress * 100), colour, bright);
  this->sunrise_step_ = step;
}

void Lumalou::sunrise_tick(bool enabled, int minutes, int minute_of_day, int second, int weekday) {
  if (!this->ready_)
    return;
  // demo: 2 minutes from the button press
  if (this->test_start_ms_ != 0) {
    const float p = (millis() - this->test_start_ms_) / 120000.0f;
    if (p >= 1.0f) {
      this->test_start_ms_ = 0;
      this->sunrise_active_ = false;
      this->sunrise_step_ = -1;
      ESP_LOGI(TAG, "Demo sunrise finished");
    } else {
      this->sunrise_active_ = true;
      this->sunrise_apply_(p);
    }
    this->changes_++;
    return;
  }
  const int wake = this->wake_minutes(weekday);
  minutes = std::max(5, std::min(90, minutes));
  bool in_window = false;
  float p = 0;
  if (enabled && wake >= 0) {
    // seconds until wake (today only; a wake time just after midnight would need yesterday's evening: not supported)
    const int now_s = minute_of_day * 60 + second, wake_s = wake * 60, start_s = wake_s - minutes * 60;
    if (now_s >= start_s && now_s < wake_s) {
      in_window = true;
      p = (float) (now_s - start_s) / (minutes * 60);
    }
  }
  if (in_window) {
    if (!this->sunrise_active_)
      ESP_LOGI(TAG, "Sunrise started (%d min before %02d:%02d)", minutes, wake / 60, wake % 60);
    this->sunrise_active_ = true;
    this->sunrise_apply_(p);
    this->changes_++;
  } else if (this->sunrise_active_) {
    // wake time reached: the lamp's own sleep trainer ("OK to get up") takes over from here
    this->sunrise_active_ = false;
    this->sunrise_step_ = -1;
    this->changes_++;
    ESP_LOGI(TAG, "Sunrise done");
  }
}

std::string Lumalou::json() const {
  const auto &g = this->g_;
  std::string s = "{";
  s += str_sprintf("\"connected\":%s,\"fw\":\"%s\",\"sunrise\":%s", this->ready_ ? "true" : "false", this->fw_.c_str(),
                   this->sunrise_active_ ? (this->test_start_ms_ ? "\"demo\"" : "\"on\"") : "false");
  if (g.valid)
    s += str_sprintf(",\"g\":{\"mode\":%d,\"activity\":%d,\"music\":%d,\"song\":%d,\"volume\":%d,\"audioTimer\":%d,"
                     "\"light\":%d,\"brightness\":%d,\"colour\":%d,\"prescaler\":%d,\"stage\":%d,\"clockOn\":%d,"
                     "\"clockBrightness\":%d,\"clock24\":%d,\"lightDuration\":%d,\"routineVolume\":%d,\"alarm\":%d}",
                     g.mode, g.activity, g.music_on, g.song, g.volume, g.audio_timer, g.light_on, g.brightness, g.colour,
                     g.prescaler, g.stage, g.clock_on, g.clock_brightness, g.clock_24h, g.light_duration,
                     g.routine_volume, g.alarm_ringing);
  if (this->date_hms_ >= 0)
    s += str_sprintf(",\"lampTime\":\"%02d:%02d:%02d\",\"lampWeekday\":%d", this->date_hms_ / 3600,
                     this->date_hms_ / 60 % 60, this->date_hms_ % 60, this->date_wd_);
  s += ",\"sleepy\":[";
  for (int d = 0; d < 7; d++) s += (d ? "," : "") + hhmm(this->sleepy_[d]);
  s += "],\"wake\":[";
  for (int d = 0; d < 7; d++) s += (d ? "," : "") + hhmm(this->r2r_[d]);
  s += "],\"alarms\":[";
  for (int d = 0; d < 7; d++) s += str_sprintf("%s%d", d ? "," : "", this->alarm_[d]);
  s += "],\"routines\":[";
  for (int d = 0; d < 7; d++) {
    s += d ? "," : "";
    if (!this->routine_known_[d]) { s += "null"; continue; }
    s += "{\"start\":" + hhmm(this->routine_start_[d]) + ",\"tasks\":[";
    for (size_t i = 0; i < this->routine_tasks_[d].size(); i++)
      s += str_sprintf("%s%u", i ? "," : "", this->routine_tasks_[d][i]);
    s += "]}";
  }
  s += str_sprintf("],\"taskStep\":%d,\"taskStatus\":[", this->task_step_);
  for (int i = 0; i < 11; i++) s += str_sprintf("%s%d", i ? "," : "", this->task_status_[i]);
  s += str_sprintf("],\"clock\":{\"on\":%d,\"brightness\":%d,\"h24\":%d},\"playlist\":[", this->clock_on_,
                   this->clock_brightness_, this->clock_24h_);
  for (size_t i = 0; i < this->playlist_.size(); i++) s += str_sprintf("%s%u", i ? "," : "", this->playlist_[i]);
  s += "]}";
  return s;
}

// ---- session -----------------------------------------------------------------------------------------------

bool Lumalou::start_session_(const uint8_t *token, uint16_t len) {
  if (len < 182 || token[0] != 10) {
    ESP_LOGE(TAG, "Unexpected factory token (%u bytes, version %u)", len, len ? token[0] : 0);
    return false;
  }
  const uint8_t *lamp_pub = token + 25;  // 33 B compressed P-256
  memcpy(this->lamp_salt_, token + len - 4, 4);
  esp_fill_random(this->my_salt_, 4);

  mbedtls_ecp_group grp;
  mbedtls_mpi d, z, x, y, t, e;
  mbedtls_ecp_point me, peer;
  mbedtls_ecp_group_init(&grp);
  mbedtls_mpi_init(&d); mbedtls_mpi_init(&z); mbedtls_mpi_init(&x); mbedtls_mpi_init(&y);
  mbedtls_mpi_init(&t); mbedtls_mpi_init(&e);
  mbedtls_ecp_point_init(&me); mbedtls_ecp_point_init(&peer);
  bool ok = false;
  uint8_t buf[65], secret[32];
  size_t olen = 0;
  do {
    if (mbedtls_ecp_group_load(&grp, MBEDTLS_ECP_DP_SECP256R1) != 0) break;
    // Decompress the lamp's key: y^2 = x^3 - 3x + b (mod p); p = 3 mod 4 -> y = rhs^((p+1)/4)
    if (mbedtls_mpi_read_binary(&x, lamp_pub + 1, 32) != 0) break;
    mbedtls_mpi_mul_mpi(&t, &x, &x);
    mbedtls_mpi_mod_mpi(&t, &t, &grp.P);
    mbedtls_mpi_sub_int(&t, &t, 3);
    mbedtls_mpi_mul_mpi(&t, &t, &x);
    mbedtls_mpi_add_mpi(&t, &t, &grp.B);
    mbedtls_mpi_mod_mpi(&t, &t, &grp.P);
    mbedtls_mpi_add_int(&e, &grp.P, 1);
    mbedtls_mpi_shift_r(&e, 2);
    if (mbedtls_mpi_exp_mod(&y, &t, &e, &grp.P, nullptr) != 0) break;
    if ((uint8_t) mbedtls_mpi_get_bit(&y, 0) != (lamp_pub[0] & 1))
      mbedtls_mpi_sub_mpi(&y, &grp.P, &y);
    buf[0] = 0x04;
    mbedtls_mpi_write_binary(&x, buf + 1, 32);
    mbedtls_mpi_write_binary(&y, buf + 33, 32);
    if (mbedtls_ecp_point_read_binary(&grp, &peer, buf, 65) != 0 || mbedtls_ecp_check_pubkey(&grp, &peer) != 0) {
      ESP_LOGE(TAG, "Lamp public key invalid");
      break;
    }
    if (mbedtls_ecp_gen_keypair(&grp, &d, &me, rng, nullptr) != 0) break;
    if (mbedtls_ecdh_compute_shared(&grp, &z, &peer, &d, rng, nullptr) != 0) break;
    mbedtls_mpi_write_binary(&z, secret, 32);
    if (mbedtls_ecp_point_write_binary(&grp, &me, MBEDTLS_ECP_PF_UNCOMPRESSED, &olen, buf, sizeof(buf)) != 0) break;
    ok = true;
  } while (false);
  mbedtls_ecp_group_free(&grp);
  mbedtls_mpi_free(&d); mbedtls_mpi_free(&z); mbedtls_mpi_free(&x); mbedtls_mpi_free(&y);
  mbedtls_mpi_free(&t); mbedtls_mpi_free(&e);
  mbedtls_ecp_point_free(&me); mbedtls_ecp_point_free(&peer);
  if (!ok) {
    ESP_LOGE(TAG, "Key exchange failed");
    return false;
  }

  // Mattel's key schedule: 100 x AES-128-CTR over the secret, counter block 00000000|round BE32|00'mattel'00
  uint8_t iv[16] = {0};
  memcpy(iv + 9, "mattel", 6);
  for (uint32_t round = 0; round < 100; round++) {
    iv[4] = round >> 24; iv[5] = round >> 16; iv[6] = round >> 8; iv[7] = round;
    uint8_t k[16];
    memcpy(k, secret, 16);
    aes_ctr(k, iv, secret, 32);
  }
  memcpy(this->key_, secret, 16);

  // Hello: our compressed public key (33) + our salt (4), written to the session characteristic.
  uint8_t hello[37];
  hello[0] = 0x02 | (buf[64] & 1);
  memcpy(hello + 1, buf + 1, 32);
  memcpy(hello + 33, this->my_salt_, 4);
  auto status = esp_ble_gattc_write_char(this->parent()->get_gattc_if(), this->parent()->get_conn_id(),
                                         this->session_handle_, sizeof(hello), hello, ESP_GATT_WRITE_TYPE_RSP,
                                         ESP_GATT_AUTH_REQ_NONE);
  if (status != ESP_OK) {
    ESP_LOGE(TAG, "Writing the session hello failed: %d", status);
    return false;
  }
  ESP_LOGI(TAG, "Session hello sent (lamp AP# %.10s)", (const char *) token + 7);
  return true;
}

// ---- sending -----------------------------------------------------------------------------------------------

void Lumalou::command_(const std::vector<uint8_t> &op_and_args) {
  // 01 10 | FE len payload xor
  std::vector<uint8_t> p = {0x01, 0x10, 0xFE, (uint8_t) op_and_args.size()};
  uint8_t x = (uint8_t) op_and_args.size();
  for (uint8_t b : op_and_args) {
    p.push_back(b);
    x ^= b;
  }
  p.push_back(x);
  this->queue_payload_(p);
}

void Lumalou::queue_payload_(const std::vector<uint8_t> &payload) {
  if (!this->ready_) {
    ESP_LOGW(TAG, "Lamp not connected; command dropped");
    return;
  }
  uint32_t seq = ++this->seq_;
  uint16_t n = payload.empty() ? 0 : payload.size() + 1;
  std::vector<uint8_t> pkt = {0x7E, (uint8_t) (seq >> 24), (uint8_t) (seq >> 16), (uint8_t) (seq >> 8), (uint8_t) seq,
                              (uint8_t) (n >> 8), (uint8_t) n};
  pkt.push_back(crc8(pkt.data(), 7));
  if (n) {
    size_t at = pkt.size();
    pkt.insert(pkt.end(), payload.begin(), payload.end());
    pkt.push_back(crc8(payload.data(), payload.size()));
    uint8_t iv[16] = {0};
    memcpy(iv, pkt.data() + 1, 4);
    memcpy(iv + 4, this->my_salt_, 4);
    memcpy(iv + 8, this->lamp_salt_, 4);
    aes_ctr(this->key_, iv, pkt.data() + at, n);
  }
  this->tx_queue_.push_back(pkt);
}

void Lumalou::refresh() {
  this->command_({OP_REQ_GLOBAL_STATE});
  this->command_({OP_REQ_COLOR});
  this->command_({OP_REQ_BRIGHTNESS});
  this->command_({OP_REQ_VOLUME});
  this->last_refresh_ms_ = millis();
}

void Lumalou::loop() {
  if (!this->ready_)
    return;
  if (millis() - this->last_refresh_ms_ > REFRESH_MS)
    this->refresh();
  if (this->tx_queue_.empty() || millis() - this->last_tx_ms_ < TX_GAP_MS)
    return;
  auto pkt = this->tx_queue_.front();
  this->tx_queue_.pop_front();
  for (size_t i = 0; i < pkt.size(); i += 20) {
    size_t n = std::min<size_t>(20, pkt.size() - i);
    auto status = esp_ble_gattc_write_char(this->parent()->get_gattc_if(), this->parent()->get_conn_id(),
                                           this->tx_handle_, n, pkt.data() + i, ESP_GATT_WRITE_TYPE_NO_RSP,
                                           ESP_GATT_AUTH_REQ_NONE);
    if (status != ESP_OK)
      ESP_LOGW(TAG, "TX write failed: %d", status);
  }
  this->last_tx_ms_ = millis();
}

// ---- receiving ---------------------------------------------------------------------------------------------

void Lumalou::on_rx_(const uint8_t *data, uint16_t len) {
  this->rx_buf_.insert(this->rx_buf_.end(), data, data + len);
  while (this->rx_buf_.size() >= 8) {
    if (this->rx_buf_[0] != 0x7E || crc8(this->rx_buf_.data(), 7) != this->rx_buf_[7]) {
      this->rx_buf_.erase(this->rx_buf_.begin());  // resync on the next 0x7E
      continue;
    }
    size_t n = (this->rx_buf_[5] << 8) | this->rx_buf_[6];
    if (this->rx_buf_.size() < 8 + n)
      break;
    this->on_packet_(this->rx_buf_.data(), 8 + n);
    this->rx_buf_.erase(this->rx_buf_.begin(), this->rx_buf_.begin() + 8 + n);
  }
}

void Lumalou::on_packet_(const uint8_t *pkt, size_t len) {
  size_t n = len - 8;
  if (n == 0)
    return;
  std::vector<uint8_t> body(pkt + 8, pkt + len);
  uint8_t iv[16] = {0};
  memcpy(iv, pkt + 1, 4);
  memcpy(iv + 4, this->lamp_salt_, 4);
  memcpy(iv + 8, this->my_salt_, 4);
  aes_ctr(this->key_, iv, body.data(), n);
  if (crc8(body.data(), n - 1) != body[n - 1]) {
    ESP_LOGW(TAG, "Bad body CRC (wrong session key?)");
    return;
  }
  ESP_LOGV(TAG, "RX %s", format_hex(body.data(), n - 1).c_str());
  this->on_reply_(body.data(), n - 1);
}

void Lumalou::on_reply_(const uint8_t *m, size_t n) {
  // Replies with data: 01 50 | FE len code args… xor
  if (n < 5 || m[0] != 0x01 || m[1] != 0x50 || m[2] != 0xFE)
    return;
  uint8_t len = m[3];
  if (n < (size_t) 4 + len || len == 0)
    return;
  const uint8_t code = m[4], *a = m + 5;
  const size_t na = len - 1;
  this->changes_++;
  auto hi = [](uint8_t b) { return b >> 4; };
  auto lo = [](uint8_t b) { return b & 0x0F; };
  switch (code) {
    case 0x18: if (na >= 1) this->color_ = this->g_.colour = a[0]; break;
    case 0x17: if (na >= 1) this->brightness_ = this->g_.brightness = a[0]; break;
    case 0x15: if (na >= 1) this->volume_ = this->g_.volume = a[0]; break;
    case 0x16: if (na >= 1) this->g_.light_on = a[0]; break;
    case 0x14: if (na >= 1) this->g_.song = a[0]; break;
    case 0x12: if (na >= 2) this->fw_ = str_sprintf("%u.%02u", a[0], a[1]); break;
    case 0x02:
      this->global_hex_ = format_hex(a, na);
      if (na >= 13) {
        auto &g = this->g_;
        g.valid = true;
        g.mode = hi(a[0]); g.activity = lo(a[0]);
        g.music_on = hi(a[1]); g.song = (lo(a[1]) << 4) | hi(a[2]); g.volume = lo(a[2]);
        g.audio_timer = hi(a[3]); g.light_on = lo(a[3]);
        g.brightness = hi(a[4]); g.colour = lo(a[4]);
        g.prescaler = hi(a[7]); g.stage = lo(a[7]);
        g.clock_on = hi(a[8]) ? 1 : 0; g.clock_brightness = lo(a[8]);
        g.clock_24h = hi(a[9]);
        g.light_duration = hi(a[11]); g.routine_volume = lo(a[11]);
        g.alarm_ringing = lo(a[12]);
        this->color_ = g.light_on ? g.colour : 10;
        this->brightness_ = g.brightness;
        this->volume_ = g.volume;
        this->clock_on_ = g.clock_on; this->clock_brightness_ = g.clock_brightness; this->clock_24h_ = g.clock_24h;
      }
      break;
    case 0x13:  // current date: H M S WD, BCD
      if (na >= 4 && bcd(a[0]) >= 0 && bcd(a[1]) >= 0 && bcd(a[2]) >= 0 && bcd(a[3]) >= 0) {
        this->date_hms_ = bcd(a[0]) * 3600 + bcd(a[1]) * 60 + bcd(a[2]);
        this->date_wd_ = bcd(a[3]);
      }
      break;
    case 0x19: this->playlist_.assign(a, a + na); break;
    case 0x22: parse_week_times(a, na, this->r2r_); break;
    case 0x23: parse_week_times(a, na, this->sleepy_); break;
    case 0x27:
      if (na >= 4) {
        const int v[7] = {hi(a[0]), lo(a[0]), hi(a[1]), lo(a[1]), hi(a[2]), lo(a[2]), hi(a[3])};
        for (int d = 0; d < 7; d++) this->alarm_[d] = v[d];
      }
      break;
    case 0x2B: case 0x2C: case 0x2D: case 0x2E: case 0x2F: case 0x90: case 0x91: {
      const int d = code >= 0x90 ? 5 + (code - 0x90) : code - 0x2B;  // Sun=0 … Thu=4, Fri 0x90, Sat 0x91
      if (na == 14) {
        int h = bcd(a[0]), mi = bcd(a[1]);
        this->routine_start_[d] = (h < 0 || mi < 0 || h > 23 || mi > 59) ? -1 : h * 60 + mi;
        this->routine_tasks_[d].clear();
        for (int i = 2; i < 14; i++)
          if (lo(a[i]) > 0 && lo(a[i]) < 12) this->routine_tasks_[d].push_back(lo(a[i]));
        this->routine_known_[d] = true;
      }
      break;
    }
    case 0x94:
      if (na >= 7) {
        this->task_step_ = a[0];
        for (int i = 0; i < 11; i++) this->task_status_[i] = (i % 2 == 0) ? hi(a[1 + i / 2]) : lo(a[1 + i / 2]);
      }
      break;
    case 0x99:
      if (na == 2) { this->clock_on_ = lo(a[0]); this->clock_brightness_ = hi(a[1]); this->clock_24h_ = lo(a[1]); }
      break;
    case 0x98: if (na >= 1) this->g_.routine_volume = a[0]; break;
    case 0x95: if (na >= 1) this->g_.light_duration = a[0]; break;
    case 0x1E: if (na >= 1) this->g_.mode = a[0]; break;
    case 0x20: if (na >= 1) this->g_.stage = a[0]; break;
    default: ESP_LOGD(TAG, "Reply 0x%02X: %s", code, format_hex(a, na).c_str()); break;
  }
}

// ---- BLE events --------------------------------------------------------------------------------------------

void Lumalou::gattc_event_handler(esp_gattc_cb_event_t event, esp_gatt_if_t gattc_if,
                                  esp_ble_gattc_cb_param_t *param) {
  switch (event) {
    case ESP_GATTC_DISCONNECT_EVT:
      if (this->ready_)
        ESP_LOGW(TAG, "Lamp disconnected");
      this->reset_();
      this->node_state = espbt::ClientState::IDLE;
      break;
    case ESP_GATTC_SEARCH_CMPL_EVT: {
      auto *tx = this->parent()->get_characteristic(SERVICE, CH_TX);
      auto *rx = this->parent()->get_characteristic(SERVICE, CH_RX);
      auto *fa = this->parent()->get_characteristic(SERVICE, CH_FACTORY);
      auto *se = this->parent()->get_characteristic(SERVICE, CH_SESSION);
      if (!tx || !rx || !fa || !se) {
        ESP_LOGE(TAG, "Not a Lumalou (MPID service missing)");
        break;
      }
      this->tx_handle_ = tx->handle;
      this->rx_handle_ = rx->handle;
      this->factory_handle_ = fa->handle;
      this->session_handle_ = se->handle;
      esp_ble_gattc_register_for_notify(this->parent()->get_gattc_if(), this->parent()->get_remote_bda(), rx->handle);
      break;
    }
    case ESP_GATTC_REG_FOR_NOTIFY_EVT:
      if (param->reg_for_notify.handle == this->rx_handle_ && param->reg_for_notify.status == ESP_GATT_OK)
        esp_ble_gattc_read_char(this->parent()->get_gattc_if(), this->parent()->get_conn_id(), this->factory_handle_,
                                ESP_GATT_AUTH_REQ_NONE);
      break;
    case ESP_GATTC_READ_CHAR_EVT:
      if (param->read.handle == this->factory_handle_) {
        if (param->read.status != ESP_GATT_OK) {
          ESP_LOGE(TAG, "Reading the factory token failed: %d", param->read.status);
          break;
        }
        this->start_session_(param->read.value, param->read.value_len);
      }
      break;
    case ESP_GATTC_WRITE_CHAR_EVT:
      if (param->write.handle == this->session_handle_) {
        if (param->write.status != ESP_GATT_OK) {
          ESP_LOGE(TAG, "Session hello rejected: %d", param->write.status);
          break;
        }
        this->ready_ = true;
        this->node_state = espbt::ClientState::ESTABLISHED;
        ESP_LOGI(TAG, "Session open");
        this->queue_payload_({0x01, 0x50, 0x01});  // enableReadTransmission
        this->fetch_all();
      }
      break;
    case ESP_GATTC_NOTIFY_EVT:
      if (param->notify.handle == this->rx_handle_)
        this->on_rx_(param->notify.value, param->notify.value_len);
      break;
    default:
      break;
  }
}

}  // namespace esphome::lumalou
