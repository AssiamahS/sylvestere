import SwiftUI

struct ContentView: View {
    static let appURL = URL(string: "https://assiamahs.github.io/sylvestere/?app=ios")!

    var body: some View {
        ZStack {
            Color(red: 0.102, green: 0.059, blue: 0.180).ignoresSafeArea()
            TutorWebView(url: Self.appURL)
                .ignoresSafeArea()
        }
        .statusBarHidden(false)
    }
}
