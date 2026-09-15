# Sylvestere

Speak English with Sylvie, a 3D AI tutor. Pick a scene (cafe, interview, airport, hotel, doctor, party), talk to her, and get gentle corrections with translations in your language.

- **Web / iPhone Safari:** https://assiamahs.github.io/sylvestere/
- **iOS app:** `ios/` (WKWebView shell + native speech bridge), TestFlight via GitHub Actions
- **Brain:** `worker/` Cloudflare Worker on Workers AI (`llama-3.3-70b-instruct-fp8-fast`)

## Layout

```
web/      static app: three.js + @pixiv/three-vrm avatar, Web Speech API, talks to the worker
worker/   sylvestere-api (Cloudflare Workers AI). `cd worker && wrangler deploy`
ios/      XcodeGen project. CI archives with cloud signing and uploads to TestFlight
```

## Dev

```sh
cd web && python3 -m http.server 8080   # http://localhost:8080
cd worker && wrangler dev                # then localStorage.setItem('sly_api','http://localhost:8787')
```

The avatar is the VRM 1.0 sample model from pixiv/three-vrm (MIT). Drop any VRM at `web/assets/avatar.vrm` to swap her.
