// The SPAKE2+ oracle: iGhostVT's own PairingExchange (the system's corecrypto)
// driven over stdin/stdout, so the JavaScript implementation in
// src/crypto/spake2plus.js can be checked against the real thing.
//
//   spake-oracle verifier <code>   reads X (hex), prints Y and cB;
//                                  reads cA, prints the session key or "mismatch"
//   spake-oracle prover <code>     prints X; reads Y and cB,
//                                  prints cA and the session key, or "mismatch"
import CryptoKit
import Foundation

func readHex() -> Data {
    guard let line = readLine() else { exit(2) }
    var data = Data()
    var index = line.startIndex
    while index < line.endIndex {
        let next = line.index(index, offsetBy: 2)
        data.append(UInt8(line[index ..< next], radix: 16)!)
        index = next
    }
    return data
}

func hex(_ data: Data) -> String {
    data.map { String(format: "%02x", $0) }.joined()
}

func emit(_ line: String) {
    print(line)
    fflush(stdout)
}

let arguments = CommandLine.arguments
guard arguments.count == 3 else {
    FileHandle.standardError.write(Data("usage: spake-oracle verifier|prover <code>\n".utf8))
    exit(2)
}
let code = arguments[2]
do {
    switch arguments[1] {
    case "verifier":
        let exchange = try PairingExchange(role: .verifier, code: code)
        try exchange.receiveShare(readHex())
        emit(hex(try exchange.makeShare()))
        emit(hex(try exchange.makeConfirmation()))
        do {
            let key = try exchange.verifyConfirmation(readHex())
            emit(key.withUnsafeBytes { hex(Data($0)) })
        } catch {
            emit("mismatch")
        }
    case "prover":
        let exchange = try PairingExchange(role: .prover, code: code)
        emit(hex(try exchange.makeShare()))
        try exchange.receiveShare(readHex())
        let theirs = readHex()
        do {
            let key = try exchange.verifyConfirmation(theirs)
            emit(hex(try exchange.makeConfirmation()))
            emit(key.withUnsafeBytes { hex(Data($0)) })
        } catch {
            emit("mismatch")
        }
    default:
        exit(2)
    }
} catch {
    FileHandle.standardError.write(Data("spake-oracle: \(error)\n".utf8))
    exit(1)
}
