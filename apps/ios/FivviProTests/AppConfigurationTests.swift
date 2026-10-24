import FivviAPI
import XCTest

@testable import FivviPro

/// The build configuration the tests run in (Debug) and what the app reads from it.
final class AppConfigurationTests: XCTestCase {
    func test_E008_AC8_displayNameComesFromTheCatalog() {
        let displayName = Bundle.main.localizedInfoDictionary?["CFBundleDisplayName"] as? String

        XCTAssertEqual(displayName, TestCatalog(TestCatalog.configuredLocale)["app.name"])
    }

    /// The committed default is the local dev server (scripts/test-ios.sh checks Config/Debug.xcconfig); a developer's
    /// Config/Local.xcconfig may point it at a preview or a Mac on the LAN, so this asserts what holds for all of them.
    func test_E008_debugAllowsPlainHTTPToLocalHostsOnly() throws {
        let info = Bundle.main.object(forInfoDictionaryKey: AppConfiguration.apiBaseURLKey)
        let configured = try XCTUnwrap(info as? String)
        let url = AppConfiguration.apiBaseURL(info: Bundle.main.infoDictionary, defaults: try emptyDefaults())

        XCTAssertEqual(url, URL(string: configured), "the base URL comes from the build configuration")
        XCTAssertEqual(url.path(), "/api")
        let transportSecurity = try XCTUnwrap(Bundle.main.infoDictionary?["NSAppTransportSecurity"] as? [String: Any])
        XCTAssertEqual(transportSecurity as NSDictionary, ["NSAllowsLocalNetworking": true], "local networking only")
        if url.scheme == "http" {
            XCTAssertTrue(Self.isLocal(try XCTUnwrap(url.host())), "plain HTTP only to a local host, not \(url)")
        } else {
            XCTAssertEqual(url.scheme, "https")
        }
    }

    func test_E008_localHostsAreLoopbackPrivateOrLinkLocalOnly() {
        let local = [
            "localhost", "mac-mini", "mac-mini.local", "127.0.0.1", "10.0.0.5", "192.168.1.20", "172.16.0.1",
            "172.31.255.255", "169.254.10.1", "::1", "fd00::1", "fc00::1", "fe80::1"
        ]
        let remote = [
            "fdic.gov", "fdn.example.com", "fe80.example.com", "10.evil.0.0.1", "10.0.0", "10.0.0.256", "8.8.8.8",
            "172.15.0.1", "172.32.0.1", "api.example.com", "2001:db8::1"
        ]
        for host in local {
            XCTAssertTrue(Self.isLocal(host), host)
        }
        for host in remote {
            XCTAssertFalse(Self.isLocal(host), host)
        }
    }

    func test_E008_debugBaseURLCanBeOverriddenAtLaunch() throws {
        let defaults = try emptyDefaults()
        defaults.set("https://preview.example.com/api", forKey: AppConfiguration.apiBaseURLKey)

        let url = AppConfiguration.apiBaseURL(info: Bundle.main.infoDictionary, defaults: defaults)

        XCTAssertEqual(url, URL(string: "https://preview.example.com/api"))
    }

    /// The version is the one of both apps (apps/Version.xcconfig, which `pnpm test:ios` compares with the resolved
    /// build settings); the build number comes from the build setting `CURRENT_PROJECT_VERSION`, which is 1 unless a
    /// release run passes its own, so Debug builds and CI test builds are build 1 (E017 AC4).
    func test_E017_AC4_bundleVersionFromBuildSetting() throws {
        let info = try XCTUnwrap(Bundle.main.infoDictionary)

        XCTAssertEqual(info["CFBundleVersion"] as? String, "1", "the build number of a Debug or CI test build")
        let version = try XCTUnwrap(info["CFBundleShortVersionString"] as? String)
        XCTAssertNotNil(version.wholeMatch(of: /\d+\.\d+\.\d+/), "\(version) is not <major>.<minor>.<patch>")
    }

    /// The bundle ID is final once the first build is uploaded (README.md, "Identifiers"; `pnpm test:ios` checks that
    /// the README records the same ID).
    func test_E017_AC8_bundleIDIsTheFinalID() {
        XCTAssertEqual(Bundle.main.bundleIdentifier, "app.fivvi.pro")
    }

    /// A host on this Mac or the LAN: an unqualified name (`localhost`), a `.local` name, or a loopback, private or
    /// link-local IP address (IPv4 `127/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`; IPv6 `::1`, `fc00::/7`,
    /// `fe80::/10`). A public host must use HTTPS.
    static func isLocal(_ host: String) -> Bool {
        let host = host.lowercased()
        if host.contains(":") {
            return host == "::1" || host.hasPrefix("fc") || host.hasPrefix("fd") || host.hasPrefix("fe80:")
        }
        if !host.contains(".") || host.hasSuffix(".local") { return true }
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        let octets = labels.compactMap { UInt8($0) }
        guard labels.count == 4, octets.count == 4 else { return false }
        switch (octets[0], octets[1]) {
        case (10, _), (127, _), (192, 168), (169, 254), (172, 16...31): return true
        default: return false
        }
    }
}
