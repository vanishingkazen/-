import Foundation
import Security

struct PairingCredential: Codable {
    let baseURL: URL
    let token: String
}

enum CredentialStore {
    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "com.steamgamecode.companion.pairing",
         kSecAttrAccount as String: "desktop"]
    }
    static func load() -> PairingCredential? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(PairingCredential.self, from: data)
    }
    static func save(_ credential: PairingCredential) throws {
        let data = try JSONEncoder().encode(credential)
        let update = [kSecValueData as String: data]
        let status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var entry = query
            entry[kSecValueData as String] = data
            entry[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            guard SecItemAdd(entry as CFDictionary, nil) == errSecSuccess else { throw StoreError.failed }
        } else if status != errSecSuccess { throw StoreError.failed }
    }
    static func clear() { SecItemDelete(query as CFDictionary) }
    enum StoreError: LocalizedError {
        case failed
        var errorDescription: String? { "无法保存配对凭据，请重新配对" }
    }
}
