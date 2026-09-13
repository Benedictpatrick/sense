# AbleMind — Pitch Deck Content

> Copy this whole file into your slide-generation prompt. Each `## Slide N` section is one slide.
> Suggested style: dark background, one big idea per slide, large type, minimal bullets (3-5 max),
> generous whitespace. Speaker notes are in *italics* under each slide's content — don't put those
> on the slide itself, they're for whoever's presenting.

---

## Slide 1 — Title

**AbleMind**
*Empowering without being limiting*

An AI-fused wearable navigation and communication system for the blind, low-vision, and Deaf/hard-of-hearing — built on a phone and a $10 microcontroller.

**Sub-line:** EchoSense (navigation) + GestureTalk (sign language) — one platform, two senses restored.

*Open with this. Keep it on screen for ~5 seconds before moving on — don't read it aloud, let it land.*

---

## Slide 2 — The Problem

- **2.2 billion people** worldwide live with vision impairment (WHO). Most mobility aids haven't fundamentally changed in decades — a white cane tells you *something* is there, not *what* it is or *what to do about it*.
- Guide dogs cost **$40,000+** to train and aren't accessible to most people who need them.
- Existing "smart" solutions are either **expensive dedicated hardware** (thousands of dollars) or **cloud apps with no real-time hazard reflex** — you point, wait, and hope the answer comes back before you've already walked into something.
- **The gap:** nothing combines instant physical hazard detection with actual scene understanding, in real time, on hardware anyone can afford.

*This is the slide that earns you the right to show a solution. Don't rush it.*

---

## Slide 3 — The Solution: EchoSense

**Two senses, fused into one verdict.**

- **Sonar** (like a bat) — ultrasonic chirp + on-device AI, reacts in ~350ms. Fast, but only knows "something is there," not what.
- **Vision** (like a sighted guide) — a phone camera + AI vision model, understands *what's* ahead and *what to do* — "chair on your left, swing right" — but takes ~2-3 seconds per read.
- **Fusion layer** — combines both into one hazard verdict, spoken aloud and pushed to a wearable LED indicator, with sonar covering the speed gap while vision "catches up."

*This is the core pitch: not two features bolted together, one system that reasons across two senses like a human does.*

---

## Slide 4 — How It Works (Sense → Fuse → Act)

```
   SENSE                        FUSE                         ACT
┌───────────┐              ┌─────────────┐              ┌─────────────┐
│  Sonar     │──classify──▶│              │──speech────▶│ Phone TTS    │
│ (chirp +   │  1D CNN     │   Unified    │──vibration─▶│ Phone haptics│
│  mic, on-  │  ~350ms     │   Hazard     │──BLE────────▶│ ESP32 LEDs  │
│  device)   │             │   Verdict    │              │             │
└───────────┘              │              │              └─────────────┘
┌───────────┐              │ NONE/CAUTION/│
│  Vision    │──describe──▶│    STOP      │
│ (camera +  │  NVIDIA NIM │              │
│  cloud VLM)│  ~2.5s      │              │
└───────────┘              └─────────────┘
```

- Sonar and vision run as two **independent, concurrent loops** — sonar never waits on vision, so a slow or rate-limited camera call never blocks the fast reflex path.
- The fused verdict is the **worse (more urgent) of the two readings**, always — safety-first by construction.
- Every output channel (speech, phone vibration, ESP32 LEDs) is driven off the *same* fused verdict, so every signal the user gets agrees with every other one.

*This is your architecture slide — the one technical judges will actually study. Keep the diagram, cut nothing.*

---

## Slide 5 — Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Frontend / app shell | **Next.js 16.3 (App Router, Turbopack)**, **React 19.2**, **TypeScript** | Modern, fast dev loop, one codebase for the whole app |
| Styling | **Tailwind CSS v4** | Rapid, consistent UI under demo time pressure |
| On-device ML (sonar) | **TensorFlow.js 4.22** — custom 1D CNN | Runs entirely in-browser, no round-trip latency, works offline |
| Sonar signal processing | Custom **chirp generation + cross-correlation** (Web Audio API) | Classic sonar/radar technique — turns a phone speaker + mic into an ultrasonic rangefinder |
| Vision AI | **NVIDIA NIM** — `meta/llama-3.2-11b-vision-instruct` (free tier) | Real vision-language model, zero API cost, OpenAI-compatible endpoint |
| Speech output | **Web Speech API** (`SpeechSynthesisUtterance`) | Native browser TTS, zero extra dependencies, works offline once loaded |
| Hardware link | **Web Bluetooth (BLE)** | No native app needed — the browser talks directly to the wearable |
| Wearable | **ESP32** running **C++ (Arduino/PlatformIO)**, **BLE GATT server** | Cheap (~$10), battery-powered, drives two indicator LEDs as a physical hazard signal |
| Hosting | **Vercel** (serverless Functions + static hosting) | One-command deploys, instant HTTPS (required for camera/mic/Bluetooth permissions), scales automatically |
| Gesture feature | **MediaPipe Tasks Vision** (hand landmarks) + custom **CNN** (fingerspelling, trained on Sign Language MNIST) | Second modality on the same platform — sign language to voice |

*If a judge asks "what's actually novel here vs. calling an API," this slide is your answer: on-device ML + classic signal processing + a fused reasoning layer, not just a wrapper around one model.*

---

## Slide 6 — Deep Dive: The Vision AI

- Model: **Llama 3.2 11B Vision Instruct**, served free via **NVIDIA NIM** (`build.nvidia.com`) — an OpenAI-compatible multimodal chat endpoint.
- **Prompt-engineered for a live sighted-guide voice**, not a form: every response names the specific object, its clock-position, distance in steps, and a concrete action — "Chair on your left, few steps up — swing right," not "Object detected: chair."
- **Frame captured at 1280×720 / 85% JPEG** for enough detail to actually read signage and identify specific objects, not just shapes.
- **Hazard-first prioritization** baked into the prompt: moving people/vehicles, steps, curbs, and drop-offs always outrank background detail, and anything within a couple of steps is treated as urgent even if visually minor.
- **Honest engineering note (great pitch material):** we tried giving the model memory of the previous frame for smoother narration ("still clear," "closer now") — and caught it hallucinating safety in testing: on an *unchanged* frame with an obstacle 2 steps away, it said "Clear, keep going straight." We killed that feature the moment we found it, rather than ship something less trustworthy. **Every frame is judged independently now.**

*That last bullet is your strongest credibility line — it shows you test for safety failures, not just feature completeness. Say it plainly; don't bury it.*

---

## Slide 7 — Deep Dive: On-Device Sonar

- The phone emits an ultrasonic **chirp** through its speaker and records the echo through its mic — literally sonar, the same principle bats and submarines use.
- **Cross-correlation** between the emitted chirp and the recorded echo finds the reflection delay → converted to distance.
- A custom **1D CNN**, trained on real collected data and running entirely via **TensorFlow.js in-browser**, classifies the reflection signature into: wall, person, doorway, stairs, or none.
- An **adaptive controller** tunes chirp gain and polling interval in real time based on signal quality — noisy environment, it adapts; clean signal, it speeds up.
- A **prediction smoother** (EMA + switch-confirmation) kills flicker so the output doesn't jitter between labels frame to frame.
- Runs at roughly **350ms per cycle** — about 7× faster than the vision loop, entirely on-device, **works with zero internet connection**.

*This is the slide for "what happens if the WiFi dies" — sonar keeps working regardless, because it's not calling out to anything.*

---

## Slide 8 — Deep Dive: Sensor Fusion (the actual innovation)

- Sonar and vision don't just run in parallel — they're combined into **one verdict** via a severity function: `combined = worse(sonarHazard, visionHazard)`.
- **Sonar bridges the vision gap**: since vision only updates every ~2.5s, an urgent sonar-only detection (something within 0.5m, or stairs at any distance) speaks up immediately as a reflex alert — rate-limited to avoid nagging — instead of leaving the user waiting on the slower camera call.
- **Priority-based speech arbitration**: both loops share one voice output. An urgent warning (active hazard) can never be cut off mid-sentence by a routine narration update — we found and fixed exactly this race condition during testing.
- **Fused hardware signal**: the ESP32's wearable LEDs strobe into a distinct "hard-stop" pattern triggered by *either* sensor crossing into danger — not just vision, not just sonar.
- The result reads to the user as **one coherent system with judgment**, not two features glued together.

*If you only have time for one deep-dive slide with a live judge, make it this one — it's the technical differentiator.*

---

## Slide 9 — Reliability Engineering (built for a live demo, not just a lab)

- **Circuit breaker on the vision API**: after 3 consecutive failures (rate limit, network blip, etc.), vision pauses for a 30s cooldown and retries automatically — instead of erroring every cycle in front of an audience. Sonar and the ESP32 are completely unaffected the entire time.
- **Rate-limit-aware backoff**: NVIDIA's free-tier `429` responses are detected distinctly and back off instead of hammering an exhausted quota.
- **Auto-reconnect**: if the camera or mic stream drops unexpectedly (OS reclaims it, app backgrounded), it's silently reacquired without user intervention.
- **Graceful on-screen degradation**: "Vision paused — sonar navigation keeps working normally" is shown explicitly, so a vision outage reads as *handled*, not *broken*.

*Judges remember when a demo breaks live. This slide is your insurance — mention it even if nothing goes wrong, because it shows engineering maturity most hackathon projects skip.*

---

## Slide 10 — Real-World Test Results

*(Fill this in with your actual obstacle-course numbers — the app now has a built-in test-run logger for exactly this.)*

| Condition | Trials | Avg. duration | Collisions | Near misses |
|---|---|---|---|---|
| Baseline (blindfolded, no assist) | — | — | — | — |
| With EchoSense | — | — | — | — |

**Headline number to lead with:** *"[X] collisions → [Y] collisions across [N] blindfolded walks of the same obstacle course."*

*Run at least 2-3 trials of each condition before the event if you can. Even a small real sample beats a hypothetical — judges can tell the difference. Use the "Test run logger" panel at the bottom of the `/infer` page: pick Baseline or Assisted, Start run, have a spotter tap Collision/Near miss as you go, End run — it timestamps and stores everything automatically.*

---

## Slide 11 — Why This Wins (differentiation)

| | White cane | Guide dog | Existing scene-description apps (Be My Eyes, Seeing AI) | **AbleMind EchoSense** |
|---|---|---|---|---|
| Real-time hazard reflex | ✅ (touch only) | ✅ | ❌ (slow, on-demand) | ✅ (~350ms sonar) |
| Understands *what's* ahead | ❌ | ❌ | ✅ (on request) | ✅ (continuous) |
| Tells you what to *do*, not just what's there | ❌ | Partial | ❌ (describes, doesn't instruct) | ✅ (action-first) |
| Works with zero internet | ✅ | ✅ | ❌ | ✅ (sonar path) |
| Cost | ~$30 | ~$40,000 | Free / phone only | **Free tier AI + ~$10 hardware** |
| Physical wearable feedback | ❌ | ❌ | ❌ | ✅ (ESP32 LEDs, vibration) |

*Let this table speak for itself — don't read every cell, just land on the cost and reflex-speed rows.*

---

## Slide 12 — The Broader Platform: AbleMind

EchoSense is one half of AbleMind — the same philosophy applied to a second sense:

**GestureTalk** — sign language to voice, in real time:
- **MediaPipe hand-landmark tracking** for common word gestures (rule-based classification).
- A custom **CNN trained on Sign Language MNIST** for A-Z fingerspelling when there's no pre-built rule for a word.
- Same principle as EchoSense: on-device, real-time, speaks output aloud — restoring a channel of communication, not just displaying data.

*One line is enough here unless a judge asks — this slide exists to show the platform vision, not to re-pitch a second product.*

---

## Slide 13 — What's Next

- Expand the sonar training dataset for more obstacle classes and better generalization across environments.
- Bring vision inference on-device (or to a self-hosted model) to remove the cloud dependency entirely for full offline operation.
- Wearable form factor beyond LEDs — haptic motor array on the ESP32 for directional vibration (left/right/stop) without needing to hold the phone.
- Real user studies with the blind/low-vision community — design partnership, not just testing on sighted volunteers.

*Keep this slide short — it signals maturity ("we know what's unfinished") without turning the pitch into a to-do list.*

---

## Slide 14 — Thank You / Ask

**AbleMind — Empowering without being limiting.**

Live demo: `https://ablemind-murex.vercel.app`

*[Insert your actual ask here — funding, mentorship, pilot users, whatever this competition is for.]*

---

## Appendix — Quick-reference facts (for Q&A, not slides)

- Sonar cycle: ~350ms (adaptive, tunes based on signal quality)
- Vision cycle: ~2.5s normally, backs off to 6s after a failure, pauses 30s after 3 consecutive failures
- Vision hazard escalation for sonar: <0.5m = stop, <1.2m = caution, stairs = always stop regardless of distance
- Sonar reflex alert cooldown: 4s (prevents nagging while stationary near an obstacle)
- Image sent to the vision model: 1280×720, JPEG quality 0.85
- Vision model: `meta/llama-3.2-11b-vision-instruct` via NVIDIA NIM, free tier
- Deployed on Vercel, HTTPS by default (required for camera/mic/Bluetooth permissions on mobile)
- ESP32 firmware: C++/Arduino, BLE GATT server, two GPIO-driven LEDs, protocol is a simple `<classCode>,<distanceMeters>` ASCII string over BLE writes
