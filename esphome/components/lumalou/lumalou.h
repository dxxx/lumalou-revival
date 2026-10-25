#pragma once

// Fisher-Price Lumalou over Bluetooth LE, clean-room re-implementation (see docs/PROTOCOL.md).
//
// Session ("MPID"): read the factory token (…0004) -> ECDH P-256 with the lamp's public key (token[25:58]) ->
// 100 rounds of AES-128-CTR over the secret (counter block 00000000|round|00'mattel'00) -> session key;
// write our compressed public key + 4-byte salt to …0005.
// Packet: 7E | seq BE32 | len BE16 | crc8 ; body = payload|crc8, AES-128-CTR (seq|txSalt|rxSalt|00000000).
// Command payload: 01 10 FE len [opcode args] xor  (enable replies first: 01 50 01).

#include <deque>
#include <string>
#include <vector>

#include "esphome/components/ble_client/ble_client.h"
#include "esphome/core/component.h"

namespace esphome::lumalou {

namespace espbt = esphome::esp32_ble_tracker;

// Opcodes (as used by the official app)
static const uint8_t OP_SET_GLOBAL_ON = 0x03;
static const uint8_t OP_REQ_GLOBAL_STATE = 0x53;
static const uint8_t OP_REQ_FW = 0x35;
static const uint8_t OP_SET_BRIGHTNESS = 0x3A;
static const uint8_t OP_REQ_BRIGHTNESS = 0x3B;
static const uint8_t OP_SET_COLOR = 0x3C;
static const uint8_t OP_REQ_COLOR = 0x3D;
static const uint8_t OP_LIGHT_OFF = 0x3E;
static const uint8_t OP_SET_VOLUME = 0x37;
static const uint8_t OP_AUDIO_OFF = 0x38;
static const uint8_t OP_REQ_VOLUME = 0x39;
static const uint8_t OP_PLAY_AUDIO = 0x3F;

class Lumalou : public Component, public ble_client::BLEClientNode {
 public:
  void setup() override;
  void loop() override;
  void dump_config() override;
  float get_setup_priority() const override { return setup_priority::DATA; }
  void gattc_event_handler(esp_gattc_cb_event_t event, esp_gatt_if_t gattc_if,
                           esp_ble_gattc_cb_param_t *param) override;

  // Actions (from the page / YAML lambdas)
  void set_color(int c) { this->command_({OP_SET_COLOR, (uint8_t) c}); this->command_({OP_REQ_COLOR}); }
  void set_brightness(int b) { this->command_({OP_SET_BRIGHTNESS, (uint8_t) b}); this->command_({OP_REQ_BRIGHTNESS}); }
  void light_off() { this->command_({OP_LIGHT_OFF}); this->command_({OP_REQ_GLOBAL_STATE}); }
  void set_volume(int v) { this->command_({OP_SET_VOLUME, (uint8_t) v}); this->command_({OP_REQ_VOLUME}); }
  void play(int sound) { this->command_({OP_PLAY_AUDIO, (uint8_t) sound}); this->command_({OP_REQ_GLOBAL_STATE}); }
  void audio_off() { this->command_({OP_AUDIO_OFF}); this->command_({OP_REQ_GLOBAL_STATE}); }
  void refresh();
  /// Raw command for experiments: opcode + args, e.g. send_raw({0x3C, 3}).
  void send_raw(const std::vector<uint8_t> &op_and_args) { this->command_(op_and_args); }
  /// The page sends commands as hex text ("48 19 30 …" = opcode + args); a known setter is followed by its read-back.
  void send_hex(const std::string &hex);
  /// Set the lamp's clock (it only keeps hour/minute/second/weekday; 0 = Sunday).
  void set_date(int hour, int minute, int second, int weekday);
  /// Re-read everything the app reads on connect (fetchProperties) + clock settings.
  void fetch_all();
  /// Everything known about the lamp as JSON, for the page.
  std::string json() const;
  uint32_t changes() const { return this->changes_; }
  /// True once per connection until set_date() has been called (YAML pushes internet time then).
  bool needs_date() const { return this->ready_ && !this->date_set_; }

  /// Sunrise wake light: called every few seconds with local time. Before today's wake time (sleep trainer,
  /// r2r slot of this morning) the light fades red -> orange -> yellow, brightness 1 -> 9, over `minutes`.
  void sunrise_tick(bool enabled, int minutes, int minute_of_day, int second, int weekday);
  /// A 2-minute demo sunrise starting now (works even when the schedule is empty).
  void test_sunrise() { this->test_start_ms_ = millis(); this->sunrise_step_ = -1; }
  /// Wake time of the given morning (0 = Sunday) in minutes since midnight, or -1.
  int wake_minutes(int weekday) const { return weekday >= 0 && weekday < 7 ? this->r2r_[weekday] : -1; }

  // State (as last reported by the lamp; -1 = unknown)
  bool ready() const { return this->ready_; }
  int color() const { return this->color_; }
  int brightness() const { return this->brightness_; }
  int volume() const { return this->volume_; }
  const std::string &global_state() const { return this->global_hex_; }
  const std::string &firmware() const { return this->fw_; }

 protected:
  void reset_();
  bool start_session_(const uint8_t *token, uint16_t len);
  void command_(const std::vector<uint8_t> &op_and_args);
  void queue_payload_(const std::vector<uint8_t> &payload);
  void on_rx_(const uint8_t *data, uint16_t len);
  void on_packet_(const uint8_t *pkt, size_t len);
  void on_reply_(const uint8_t *msg, size_t len);

  uint16_t tx_handle_{0}, rx_handle_{0}, factory_handle_{0}, session_handle_{0};
  bool ready_{false};
  uint8_t key_[16]{};
  uint8_t my_salt_[4]{}, lamp_salt_[4]{};
  uint32_t seq_{0};
  std::deque<std::vector<uint8_t>> tx_queue_;  // encrypted packets waiting to be written
  uint32_t last_tx_ms_{0};
  std::vector<uint8_t> rx_buf_;

  int color_{-1}, brightness_{-1}, volume_{-1};
  std::string global_hex_, fw_;
  uint32_t last_refresh_ms_{0};

  // Decoded state (COMMANDS.md). -1 = unknown. Times: minutes since midnight, -1 = none, -2 = unknown.
  struct Global {
    bool valid{false};
    int mode{-1}, activity{-1}, music_on{-1}, song{-1}, volume{-1}, audio_timer{-1}, light_on{-1}, brightness{-1},
        colour{-1}, prescaler{-1}, stage{-1}, clock_on{-1}, clock_brightness{-1}, clock_24h{-1}, light_duration{-1},
        routine_volume{-1}, alarm_ringing{-1};
  } g_;
  int date_hms_{-1}, date_wd_{-1};  // lamp clock (seconds since midnight), weekday 0 = Sun
  int sleepy_[7]{-2, -2, -2, -2, -2, -2, -2}, r2r_[7]{-2, -2, -2, -2, -2, -2, -2};
  int alarm_[7]{-1, -1, -1, -1, -1, -1, -1};
  int routine_start_[7]{-2, -2, -2, -2, -2, -2, -2};
  std::vector<uint8_t> routine_tasks_[7];
  bool routine_known_[7]{};
  int task_step_{-1};
  int task_status_[11]{-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1};
  int clock_on_{-1}, clock_brightness_{-1}, clock_24h_{-1};
  std::vector<uint8_t> playlist_;
  uint32_t changes_{0};
  bool date_set_{false};
  // sunrise
  int sunrise_step_{-1};          // last (colour, brightness) step sent; -1 = not running
  bool sunrise_active_{false};
  uint32_t test_start_ms_{0};     // demo sunrise start (0 = none)
  void sunrise_apply_(float progress);
};

}  // namespace esphome::lumalou
