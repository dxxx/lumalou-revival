# Fisher-Price Lumalou (Mattel GWM53) over Bluetooth LE, without the discontinued app.
# Implements Mattel's "MPID" session (ECDH P-256 + AES-128-CTR) and the Lumalou commands.
# Protocol notes: docs/PROTOCOL.md and docs/COMMANDS.md (reference implementation: python/mpid.py, python/lumalou.py)
import esphome.codegen as cg
from esphome.components import ble_client
import esphome.config_validation as cv
from esphome.const import CONF_ID

DEPENDENCIES = ["ble_client"]
CODEOWNERS = []

lumalou_ns = cg.esphome_ns.namespace("lumalou")
Lumalou = lumalou_ns.class_("Lumalou", cg.Component, ble_client.BLEClientNode)

CONFIG_SCHEMA = (
    cv.Schema({cv.GenerateID(): cv.declare_id(Lumalou)})
    .extend(ble_client.BLE_CLIENT_SCHEMA)
    .extend(cv.COMPONENT_SCHEMA)
)


async def to_code(config):
    var = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(var, config)
    await ble_client.register_ble_node(var, config)
