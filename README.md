# Antigravity Tailscale Bridge

A lightweight, zero-configuration Node.js bridge server that securely exposes the local Antigravity desktop app's Go language server Connect RPC endpoints to your private Tailscale network.

---

## 🚀 How to Run the Bridge

1. Ensure **Tailscale** is active and connected on your Mac.
2. Open a terminal and navigate to your project directory:
   ```bash
   cd path/to/antigravity-bridge
   ```
3. Start the bridge:
   ```bash
   npm start
   ```
4. Verify the startup logs:
   - It will output your private Tailscale IP (e.g. `http://100.X.Y.Z:8080`).
   - If Tailscale is offline or not installed, it falls back to `127.0.0.1:8080`.
5. Open the URL in your web browser (on your Mac or on your Android device connected to Tailscale) to access the **Interactive Dashboard & Live API Console**.

---

## 🛡️ Security Model

- **Binds to Tailscale:** The bridge binds strictly to your Mac's Tailscale IPv4 address (`100.X.Y.Z`). Only devices authorized on your Tailnet can see or hit the bridge. It is completely isolated from local physical Wi-Fi and public internet interfaces.
- **Dynamic Credential Scraper:** The bridge dynamically locates the active Antigravity process and parses its dynamic CSRF token and port on launch and request execution. No hardcoded credentials or manual copy-pasting is ever required.
- **Transparent Credentials Injection:** The bridge automatically injects the required `X-Codeium-Csrf-Token` and routes requests to the correct dynamic port on `localhost`.

---

## 📱 Android Client Integration

Because the bridge acts as a **transparent reverse proxy**, it preserves all standard Connect RPC headers, byte-stream frames, and JSON payloads. 

### Base URL
Configure your Android client to use your Mac's Tailscale address:
```
http://<YOUR_MAC_TAILSCALE_IP>:8080/
```

### Supported API Endpoints
You can invoke *any* method on the `LanguageServerService` using standard Connect RPC JSON payloads over HTTP POST.

#### 1. Send User Prompt (`SendUserCascadeMessage`)
- **Route:** `POST /exa.language_server_pb.LanguageServerService/SendUserCascadeMessage`
- **Request Body (JSON):**
  ```json
  {
    "message": {
      "text": "Hello, Antigravity!",
      "role": "user"
    },
    "cascadeId": "session-unique-uuid-or-id"
  }
  ```
- **Response Format:** A stream of Connect RPC enveloped chunks. Each chunk begins with a 5-byte header:
  - `byte[0]`: Flags (0 = data, 2 = end/trailer)
  - `byte[1..4]`: 32-bit big-endian integer specifying the length of the JSON payload that immediately follows.
  - `byte[5..5+length]`: The UTF-8 JSON payload representing the message token chunk.

#### 2. Get Conversation Trajectory (`GetCascadeTrajectory`)
- **Route:** `POST /exa.language_server_pb.LanguageServerService/GetCascadeTrajectory`
- **Request Body (JSON):**
  ```json
  {
    "cascadeId": "session-unique-uuid-or-id",
    "trajectoryVerbosity": 2
  }
  ```
- **Response:** Returns the full conversation state, including all steps executed, file modifications, code output, and token cost summaries.

---

## 🛠️ Launching as a macOS LaunchAgent (Running in Background)

To make the bridge run automatically in the background on startup without having to open a terminal:

1. Create a file named `com.username.antigravity-bridge.plist` in `~/Library/LaunchAgents/` (replacing `username` with your macOS username):
   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
       <key>Label</key>
       <string>com.username.antigravity-bridge</string>
       <key>ProgramArguments</key>
       <array>
           <string>/usr/local/bin/node</string>
           <string>/Users/YOUR_USERNAME/.gemini/antigravity/scratch/antigravity-bridge/bridge.js</string>
       </array>
       <key>RunAtLoad</key>
       <true/>
       <key>KeepAlive</key>
       <true/>
       <key>WorkingDirectory</key>
       <string>/Users/YOUR_USERNAME/.gemini/antigravity/scratch/antigravity-bridge</string>
       <key>StandardOutPath</key>
       <string>/Users/YOUR_USERNAME/.gemini/antigravity/scratch/antigravity-bridge/bridge.log</string>
       <key>StandardErrorPath</key>
       <string>/Users/YOUR_USERNAME/.gemini/antigravity/scratch/antigravity-bridge/bridge.err.log</string>
   </dict>
   </plist>
   ```
2. Load the daemon:
   ```bash
   launchctl load ~/Library/LaunchAgents/com.username.antigravity-bridge.plist
   ```

---

## 📄 License

This project is open-source and available under the [MIT License](LICENSE). It is completely free to use, modify, distribute, and integrate for private or commercial purposes.

## 🤝 Contributing

Contributions, bug reports, and suggestions are welcome!
1. Fork the repository.
2. Create a feature branch: `git checkout -b feature/cool-new-thing`.
3. Commit your changes: `git commit -m "Add some cool new thing"`.
4. Push to the branch: `git push origin feature/cool-new-thing`.
5. Submit a Pull Request.

