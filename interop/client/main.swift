// An iGhostVT client built from the app's own remote-access code (iGhostVT's
// Shared/Remote, Shared/Wire, Shared/Protocol): Network.framework TLS 1.2 PSK,
// corecrypto SPAKE2+, the device proof, IOWire frames. The interop tests
// (test/interop.test.js) drive it to check the plugin against the real thing.
//
//   ghostvt-client pair    <host> <port> <hostID> <code> <deviceID> <deviceName> <appVersion>
//       prints {"ok":true,"hostid","hostname","key":hex} or {"ok":false,"code","err"}
//   ghostvt-client connect <host> <port> <hostID> <deviceID> <keyHex> <appVersion> [deviceName]
//       sends hello with the proof, prints {"kind":"ready"} once answered, then
//       sends each stdin line {"tag":n,"msg":{…}} as a request and prints each
//       frame that arrives as {"kind":"reply"|"event","tag":n,"msg":{…}}.
//       As the app does, the hello offers compression (unless GHOSTVT_PLAIN
//       is set) and says the link reports what it receives, and a receipt
//       goes out every 256 KiB. A stdin line {"stats":true} prints
//       {"kind":"stats","received":n,"wire":n}: frame bytes as decoded, and
//       as they crossed the network.
//
// Values in JSON: strings and booleans as themselves, {"u64":"n"},
// {"i64":"n"}, {"data":"base64"}, arrays and objects.
import CryptoKit
import Foundation
import Network
import XPC

let queue = DispatchQueue(label: "ghostvt-client")

func emit(_ object: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    FileHandle.standardOutput.write(data + Data("\n".utf8))
}

func fail(_ message: String) -> Never {
    emit(["kind": "error", "err": message])
    exit(1)
}

func hexData(_ text: String) -> Data {
    var data = Data()
    var index = text.startIndex
    while index < text.endIndex {
        let next = text.index(index, offsetBy: 2)
        data.append(UInt8(text[index ..< next], radix: 16)!)
        index = next
    }
    return data
}

func hex(_ data: Data) -> String {
    data.map { String(format: "%02x", $0) }.joined()
}

// MARK: - JSON ⇄ XPC

func xpcValue(_ json: Any) -> xpc_object_t {
    if let string = json as? String { return xpc_string_create(string) }
    if let number = json as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() { return xpc_bool_create(number.boolValue) }
    if let array = json as? [Any] {
        let result = xpc_array_create(nil, 0)
        for element in array { xpc_array_append_value(result, xpcValue(element)) }
        return result
    }
    if let object = json as? [String: Any] {
        if object.count == 1, let value = object["u64"] as? String { return xpc_uint64_create(UInt64(value)!) }
        if object.count == 1, let value = object["i64"] as? String { return xpc_int64_create(Int64(value)!) }
        if object.count == 1, let value = object["data"] as? String { let data = Data(base64Encoded: value)!; return data.withUnsafeBytes { xpc_data_create($0.baseAddress, data.count) } }
        let result = xpc_dictionary_create(nil, nil, 0)
        for (key, value) in object { xpc_dictionary_set_value(result, key, xpcValue(value)) }
        return result
    }
    fail("cannot convert \(json)")
}

func jsonValue(_ value: xpc_object_t) -> Any {
    let type = xpc_get_type(value)
    if type == iGhostVTXPC.typeString { return String(cString: xpc_string_get_string_ptr(value)!) }
    if type == iGhostVTXPC.typeBool { return xpc_bool_get_value(value) }
    if type == iGhostVTXPC.typeUInt64 { return ["u64": String(xpc_uint64_get_value(value))] }
    if type == iGhostVTXPC.typeInt64 { return ["i64": String(xpc_int64_get_value(value))] }
    if type == iGhostVTXPC.typeData {
        let data = Data(bytes: xpc_data_get_bytes_ptr(value)!, count: xpc_data_get_length(value))
        return ["data": data.base64EncodedString()]
    }
    if type == iGhostVTXPC.typeArray {
        return (0 ..< xpc_array_get_count(value)).map { jsonValue(xpc_array_get_value(value, $0)) }
    }
    if type == iGhostVTXPC.typeDictionary {
        var result: [String: Any] = [:]
        xpc_dictionary_apply(value) { key, entry in
            result[String(cString: key)] = jsonValue(entry)
            return true
        }
        return result
    }
    return NSNull()
}

// MARK: - Connecting

func open(host: String, port: UInt16, hostID: String, key: RemoteTLS.Key) -> RemoteFrameConnection {
    let connection = NWConnection(
        host: NWEndpoint.Host(host),
        port: NWEndpoint.Port(rawValue: port)!,
        using: RemoteTLS.parameters(keys: [key], serverName: hostID),
    )
    return RemoteFrameConnection(connection: connection, queue: queue)
}

func request(_ fields: [String: Any]) -> xpc_object_t {
    xpcValue(fields)
}

let arguments = CommandLine.arguments
guard arguments.count >= 2 else { fail("usage: ghostvt-client pair|connect …") }

switch arguments[1] {
case "pair":
    guard arguments.count == 9 else { fail("pair <host> <port> <hostID> <code> <deviceID> <deviceName> <appVersion>") }
    let (host, port, hostID, code, deviceID, deviceName, appVersion) =
        (arguments[2], UInt16(arguments[3])!, arguments[4], arguments[5], arguments[6], arguments[7], arguments[8])
    let exchange = try! PairingExchange(role: .prover, code: code)
    let frames = open(host: host, port: port, hostID: hostID, key: RemoteTLS.Key(identity: RemoteAccess.pairingIdentity, secret: RemoteAccess.pairingKey))
    var step = 0
    frames.onReady = {
        let start = request(["v": ["u64": String(iGhostVTProtocol.version)], "op": ["u64": "30"], "devid": deviceID, "devname": deviceName, "appver": appVersion])
        let share = try! exchange.makeShare()
        share.withUnsafeBytes { xpc_dictionary_set_data(start, "share", $0.baseAddress!, share.count) }
        frames.send(.request, tag: 1, object: start)
    }
    frames.onFrame = { _, reply in
        let code = xpc_dictionary_get_int64(reply, "code")
        guard code == 0 else {
            emit(["ok": false, "code": code, "err": xpc_dictionary_get_string(reply, "err").map { String(cString: $0) } ?? ""])
            exit(0)
        }
        step += 1
        if step == 1 {
            var count = 0
            let share = Data(bytes: xpc_dictionary_get_data(reply, "share", &count)!, count: count)
            let confirmation = Data(bytes: xpc_dictionary_get_data(reply, "confirm", &count)!, count: count)
            let hostReported = String(cString: xpc_dictionary_get_string(reply, "hostid")!)
            let hostName = xpc_dictionary_get_string(reply, "hostname").map { String(cString: $0) } ?? ""
            guard hostReported == hostID else { fail("the host says it is \(hostReported)") }
            do {
                try exchange.receiveShare(share)
                let sessionKey = try exchange.verifyConfirmation(confirmation)
                let deviceKey = PairingExchange.deviceKey(sessionKey: sessionKey, hostID: hostID, deviceID: deviceID)
                let finish = request(["v": ["u64": String(iGhostVTProtocol.version)], "op": ["u64": "31"]])
                let mine = try exchange.makeConfirmation()
                mine.withUnsafeBytes { xpc_dictionary_set_data(finish, "confirm", $0.baseAddress!, mine.count) }
                frames.send(.request, tag: 2, object: finish)
                frames.onFrame = { _, reply in
                    let code = xpc_dictionary_get_int64(reply, "code")
                    if code == 0 {
                        emit(["ok": true, "hostid": hostReported, "hostname": hostName, "key": hex(deviceKey)])
                    } else {
                        emit(["ok": false, "code": code, "err": xpc_dictionary_get_string(reply, "err").map { String(cString: $0) } ?? ""])
                    }
                    exit(0)
                }
            } catch {
                emit(["ok": false, "code": -1, "err": "Incorrect code (the host's confirmation did not verify)"])
                exit(0)
            }
        }
    }
    frames.onClosed = { reason in fail("closed: \(reason)") }
    frames.start()

case "connect":
    guard arguments.count >= 8 else { fail("connect <host> <port> <hostID> <deviceID> <keyHex> <appVersion> [deviceName]") }
    let (host, port, hostID, deviceID, key, appVersion) =
        (arguments[2], UInt16(arguments[3])!, arguments[4], arguments[5], hexData(arguments[6]), arguments[7])
    let deviceName = arguments.count > 8 ? arguments[8] : "Interop"
    let frames = open(host: host, port: port, hostID: hostID, key: RemoteTLS.Key(identity: Data(deviceID.utf8), secret: key))
    var ready = false
    let offersCompression = ProcessInfo.processInfo.environment["GHOSTVT_PLAIN"] == nil
    frames.acceptsCompressedInput = offersCompression
    frames.onReady = {
        guard let exporter = RemoteTLS.exporterSecret(of: frames.connection) else { fail("no exporter secret") }
        if ProcessInfo.processInfo.environment["GHOSTVT_DEBUG"] != nil { FileHandle.standardError.write(Data("exporter \(hex(exporter))\n".utf8)) }
        let hello = request(["v": ["u64": String(iGhostVTProtocol.version)], "op": ["u64": "1"], "devid": deviceID, "devname": deviceName, "appver": appVersion])
        xpc_dictionary_set_uint64(hello, iGhostVTWireKey.received, 0)
        if offersCompression {
            RemoteFrameCompression.offer(in: hello)
        }
        let proof = RemoteDeviceProof.make(key: key, exporterSecret: exporter, deviceID: deviceID)
        proof.withUnsafeBytes { xpc_dictionary_set_data(hello, "confirm", $0.baseAddress!, proof.count) }
        frames.send(.request, tag: 1, object: hello)
    }
    frames.onFrame = { header, object in
        frames.acknowledgeReceived()
        if !ready {
            ready = true
            let code = xpc_dictionary_get_int64(object, "code")
            if code != 0 {
                emit(["kind": "refused", "code": code, "msg": jsonValue(object)])
                exit(0)
            }
            emit(["kind": "ready"])
            Thread.detachNewThread {
                while let line = readLine() {
                    guard let data = line.data(using: .utf8),
                          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                    else { continue }
                    if object["stats"] != nil {
                        queue.async { emit(["kind": "stats", "received": frames.receivedByteCount, "wire": frames.receivedWireByteCount]) }
                        continue
                    }
                    guard let message = object["msg"] else { continue }
                    let tag = (object["tag"] as? NSNumber)?.uint64Value ?? 0
                    let xpcMessage = xpcValue(message)
                    queue.async { frames.send(.request, tag: tag, object: xpcMessage) }
                }
                queue.async { frames.close(reason: "stdin ended") }
            }
            return
        }
        let kind = header.kind == .reply ? "reply" : header.kind == .event ? "event" : "other"
        emit(["kind": kind, "tag": header.tag, "msg": jsonValue(object)])
    }
    frames.onClosed = { reason in
        emit(["kind": "closed", "reason": reason])
        exit(0)
    }
    frames.start()

default:
    fail("unknown mode \(arguments[1])")
}

dispatchMain()
