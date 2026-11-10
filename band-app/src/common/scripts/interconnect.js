/**
 * WristKey band app - system.interconnect transport.
 *
 * The band side of the sync channel. Responsibilities:
 *   - create the interconnect instance and forward events to the caller
 *   - deliver outgoing ack/request JSON strings
 *   - never throw on a missing/unavailable channel: ack is "best effort"
 *
 * The Android app must use the same package name (dev.wristkey.app) and the
 * same signing certificate, otherwise system.interconnect refuses the channel.
 * Message validation/state handling lives in syncProtocol.js (pure, testable);
 * this module only does transport.
 */

import interconnect from "@system.interconnect"
import { buildSyncRequest, serializeMessage } from "./syncProtocol.js"

let connection = null
let listeners = null

/** Best-effort connection flag for UI hints (not a delivery guarantee). */
export function isConnected() {
  return connection !== null
}

/**
 * Open the interconnect channel.
 * @param {{onMessage?: function, onOpen?: function, onClose?: function,
 *          onError?: function}} [options]
 * @returns {object|null} the connection instance, or null when unavailable
 */
export function connect(options) {
  const settings = options || {}
  disconnect()
  listeners = settings
  try {
    connection = interconnect.instance()
  } catch (error) {
    connection = null
    return null
  }
  if (!connection) {
    return null
  }
  try {
    connection.onmessage = function (message) {
      callListener("onMessage", message)
    }
    connection.onopen = function () {
      callListener("onOpen")
    }
    connection.onclose = function () {
      callListener("onClose")
    }
    connection.onerror = function () {
      callListener("onError")
    }
  } catch (error) {
    connection = null
  }
  return connection
}

/** Close the channel and detach listeners. Safe to call repeatedly. */
export function disconnect() {
  if (connection) {
    try {
      connection.onmessage = null
      connection.onopen = null
      connection.onclose = null
      connection.onerror = null
    } catch (error) {
      // ignore: channel may already be gone
    }
    try {
      if (typeof connection.close === "function") {
        connection.close()
      }
    } catch (error) {
      // ignore: closing a dead channel must not break the app
    }
  }
  connection = null
  listeners = null
}

/**
 * Send one JSON payload to the phone. Callback always reports success/failure;
 * failures are non-fatal and callers may silently ignore them.
 * @param {object|string} message
 * @param {(result: {ok: boolean, error?: string}) => void} [callback]
 * @returns {boolean} true when handed to the transport
 */
export function send(message, callback) {
  const done = typeof callback === "function" ? callback : function () {}
  if (!connection) {
    done({ ok: false, error: "not_connected" })
    return false
  }

  let data
  try {
    data = typeof message === "string" ? message : serializeMessage(message)
  } catch (error) {
    done({ ok: false, error: "serialize_failed" })
    return false
  }

  try {
    connection.send({
      data: data,
      success: function () {
        done({ ok: true })
      },
      fail: function () {
        done({ ok: false, error: "send_failed" })
      }
    })
    return true
  } catch (error) {
    done({ ok: false, error: "send_failed" })
    return false
  }
}

/** Send a mfa_sync_ack (best effort). */
export function sendAck(ack, callback) {
  return send(ack, callback)
}

/** Ask the phone for a fresh full snapshot (mfa_sync_request). */
export function requestSync(callback) {
  const request = buildSyncRequest({ sentAt: Date.now() })
  return send(request, callback)
}

function callListener(name, argument) {
  if (!listeners) {
    return
  }
  const listener = listeners[name]
  if (typeof listener !== "function") {
    return
  }
  try {
    listener(argument)
  } catch (error) {
    // A broken listener must never kill the interconnect callback loop.
  }
}
