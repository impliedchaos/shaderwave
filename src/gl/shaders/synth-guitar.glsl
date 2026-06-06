// Guitar — a plucked-string synth that morphs between ACOUSTIC and ELECTRIC. Closed-
// form modal synthesis (like the piano/tanpura: no recursion) — each sample sums the
// string's decaying, nearly-harmonic partials. The string physics:
//   • PLUCK POSITION — plucking at fraction p of the string combs the spectrum
//       (|sin(nπp)|): near the bridge (small p) = bright/twangy, over the middle = mellow.
//   • Body morph (uP0.w: 0 = electric, 1 = acoustic):
//       – ACOUSTIC adds a soundboard body resonance (a formant boost ~185 Hz, the woody
//         low-mid), damps the highs faster, and has a softer pick.
//       – ELECTRIC adds a magnetic-PICKUP comb (bridge pickup ~0.15), sustains much
//         longer, stays bright, and feeds the built-in Drive (overdrive) for crunch.
//   • FREQUENCY-DEPENDENT DECAY — high partials die faster (acoustic more so).
//   • PICK/FINGER attack — a short broadband contact transient (sharper when electric).
//   • DRIVE — tanh waveshaping on the string for electric overdrive/rock.
//
// Params (per voice):
//   uP0 = (decay s, pluckPos 0.02..0.5, tone 0..1, body 0..1 [elec→acoustic])
//   uP1 = (partials 1..32, drive 0..1, pick 0..1, release s)

const int GTR_MAXN = 32;

void main(){
  int x = int(gl_FragCoord.x);
  int v = int(gl_FragCoord.y);
  outState = vec4(0.0);
  outPhase = vec4(0.0);
  outPhase2 = vec4(0.0);
  if (!voiceLive(v)) { outAudio = vec4(0.0); return; }

  float t = (float(x) - uOnRel[v]) / uSampleRate;     // seconds since note-on
  if (t < 0.0) { outAudio = vec4(0.0); return; }
  float tRel = (float(x) - uOffRel[v]) / uSampleRate; // seconds since note-off (<0 held)

  float f0    = uFreq[v];
  float vel   = uVel[v];
  float decay = max(uP0[v].x, 0.05);
  float pluck = clamp(uP0[v].y, 0.02, 0.5);
  float tone  = clamp(uP0[v].z, 0.0, 1.0);
  float body  = clamp(uP0[v].w, 0.0, 1.0);      // 0 electric .. 1 acoustic
  int   N     = int(clamp(uP1[v].x, 1.0, float(GTR_MAXN)));
  float drive = max(uP1[v].y, 0.0);
  float pick  = clamp(uP1[v].z, 0.0, 1.0);
  float rel   = max(uP1[v].w, 0.005);

  const float B = 0.00012;   // slight string stiffness (nearly harmonic)
  float nyq = uSampleRate * 0.45;
  float acc = 0.0;
  for (int n = 1; n <= GTR_MAXN; n++){
    if (n > N) break;
    float fn = f0 * float(n) * sqrt(1.0 + B * float(n * n));
    if (fn > nyq) break;

    float a = abs(sin(PI * float(n) * pluck)) / pow(float(n), 1.2);   // pluck-position comb
    a *= exp(-float(n - 1) * (1.0 - tone) * 0.13);                    // tone rolloff

    // Electric pickup comb (bridge pickup ~0.15); acoustic has none.
    float pickup = 0.4 + 0.6 * abs(sin(PI * float(n) * 0.15));
    a *= mix(pickup, 1.0, body);

    // Acoustic soundboard resonance: a gaussian boost around ~185 Hz (woody low-mid).
    float lf = log2(fn / 185.0);
    a *= 1.0 + body * 1.6 * exp(-lf * lf * 0.9);

    // Frequency-dependent decay: acoustic damps highs faster and sustains less.
    float tilt = mix(0.45, 1.5, body);
    float tau  = decay * mix(1.7, 1.0, body) / (1.0 + tilt * float(n - 1));
    float env  = exp(-t / tau);

    float phi = hash11(float(n) + float(v) * 7.13);
    acc += a * env * sin(TAU * (fn * t + phi));
  }

  // Pick/finger attack: short broadband contact, sharper when electric; onset-locked.
  float rel0 = float(x) - uOnRel[v];
  float pk = noise1(rel0 + float(v) * 23.0) * exp(-t * mix(180.0, 300.0, 1.0 - body)) * pick * 0.4;

  float relGate = tRel < 0.0 ? 1.0 : exp(-tRel / rel);   // damper / palm-mute on key-up

  float str = tanh(acc * 0.55 * relGate * (1.0 + drive * 5.0));   // built-in overdrive
  float s = (str + pk) * vel;
  outAudio = vec4(tanh(s), 0.0, 0.0, 1.0);
}
