// Guitar — a plucked-string synth that morphs between ACOUSTIC and ELECTRIC. Closed-
// form modal synthesis (like the piano/tanpura: no recursion) — each sample sums the
// string's decaying, nearly-harmonic partials. The string physics:
//   • PLUCK POSITION — plucking at fraction p of the string combs the spectrum
//       (|sin(nπp)|): near the bridge (small p) = bright/twangy, over the middle = mellow.
//   • VELOCITY → BRIGHTNESS — digging in harder excites more highs; a soft pluck is mellow.
//   • REGISTER KEY-TRACKING — low (wound) strings carry many more partials and ring longer;
//       the treble is sparser and dies faster.
//   • Body morph (uP0.w: 0 = electric, 1 = acoustic):
//       – ACOUSTIC adds a soundboard body resonance (a few fixed formant bumps — air
//         ~100 Hz, top plate ~185 Hz, a woody mode ~400 Hz), damps the highs faster, and
//         has a softer pick.
//       – ELECTRIC adds a magnetic-PICKUP comb (bridge pickup ~0.15), sustains much
//         longer, stays bright, and feeds the built-in Drive (overdrive) for crunch.
//   • FREQUENCY-DEPENDENT DECAY — high partials die faster (acoustic more so).
//   • COHERENT PLUCK + PER-VOICE DETUNE — partials start at phase 0 (zero-start, no click;
//       a defined pluck, not a random-phase "synth strings" wash), while a few-cents
//       per-voice detune stops a strummed CHORD's notes phase-locking harshly.
//   • PICK/FINGER attack — a short broadband contact transient (sharper when electric).
//   • DRIVE — tanh waveshaping on the string for electric overdrive/rock.
//
// Params (per voice):
//   uP0 = (decay s, pluckPos 0.02..0.5, tone 0..1, body 0..1 [elec→acoustic])
//   uP1 = (partials 1..32, drive 0..1, pick 0..1, release s)

const int GTR_MAXN = 48;

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
  float drive = max(uP1[v].y, 0.0);
  float pick  = clamp(uP1[v].z, 0.0, 1.0);
  float rel   = max(uP1[v].w, 0.005);

  // KEY TRACKING — register, ~1 low on the neck (wound strings), 0 around A3, negative up
  // high. Low strings ring longer and carry far more partials; the treble is sparser and
  // shorter. (Guitar open range ~E2..E4, so anchor a touch lower than the piano's A4.)
  float reg = clamp(log2(220.0 / max(f0, 1.0)) / 3.0, -0.7, 1.0);
  decay *= mix(1.0, 1.5, clamp(reg, 0.0, 1.0));    // bass sustains longer
  decay *= mix(1.0, 0.7, clamp(-reg, 0.0, 1.0));   // treble dies faster

  // MORE PARTIALS IN THE BASS — a low wound string is rich well past the base count; the
  // treble runs out of headroom below Nyquist anyway and breaks early.
  float regBoost = clamp(165.0 / max(f0, 1.0), 1.0, 2.5);
  int   N = int(clamp(uP1[v].x * regBoost, 1.0, float(GTR_MAXN)));

  // VELOCITY → BRIGHTNESS — a hard pluck excites more highs, a soft pluck is mellow; the
  // bass is a touch brighter than the treble. Drives the high-partial rolloff below.
  float bright = clamp(tone * 0.65 + vel * 0.3 + max(reg, 0.0) * 0.05, 0.0, 1.0);
  float damp   = (1.0 - bright) * 0.16;            // high-partial rolloff exponent

  // Per-VOICE micro-detune (a few cents) so a strummed CHORD's notes chorus naturally
  // instead of phase-locking into a harsh static beat. Inaudible on a single note.
  float vdet = 1.0 + (hash11(float(v) * 3.7 + 5.1) - 0.5) * 0.004;

  const float B = 0.00012;   // slight string stiffness (nearly harmonic)
  float nyq = uSampleRate * 0.45;
  float acc = 0.0;
  for (int n = 1; n <= GTR_MAXN; n++){
    if (n > N) break;
    float fn = f0 * float(n) * sqrt(1.0 + B * float(n * n));
    if (fn > nyq) break;

    float a = abs(sin(PI * float(n) * pluck)) / pow(float(n), 1.2);   // pluck-position comb
    a *= exp(-float(n - 1) * damp);                                   // tone + velocity rolloff

    // Electric pickup comb (bridge pickup ~0.15); acoustic has none.
    float pickup = 0.4 + 0.6 * abs(sin(PI * float(n) * 0.15));
    a *= mix(pickup, 1.0, body);

    // ACOUSTIC SOUNDBOARD BODY — a few fixed formant bumps (Helmholtz air ~100 Hz, top
    // plate ~185 Hz, a higher woody mode ~400 Hz) so the box reads as resonant, not bare.
    float bodyResp = 1.0
      + 0.9 * exp(-pow((fn - 100.0) / 45.0,  2.0))
      + 1.3 * exp(-pow((fn - 185.0) / 70.0,  2.0))
      + 0.5 * exp(-pow((fn - 400.0) / 180.0, 2.0));
    a *= mix(1.0, bodyResp, body);

    // Frequency-dependent decay: acoustic damps highs faster and sustains less.
    float tilt = mix(0.45, 1.5, body);
    float tau  = decay * mix(1.7, 1.0, body) / (1.0 + tilt * float(n - 1));
    float env  = exp(-t / tau);

    // COHERENT PLUCK — every partial starts at phase 0, so the note begins exactly at zero
    // (no onset click) and the harmonics sum to a defined, percussive pluck (random phases
    // smear it into a generic "synth strings" wash). vdet keeps stacked chord notes from
    // phase-locking without smearing the single-note timbre.
    acc += a * env * sin(TAU * fn * vdet * t);
  }

  // Pick/finger attack: short broadband contact, sharper when electric; onset-locked.
  float rel0 = float(x) - uOnRel[v];
  float pk = noise1(rel0 + float(v) * 23.0) * exp(-t * mix(180.0, 300.0, 1.0 - body)) * pick * 0.4;

  float relGate = tRel < 0.0 ? 1.0 : exp(-tRel / rel);   // damper / palm-mute on key-up

  float str = tanh(acc * 0.5 * relGate * (1.0 + drive * 5.0));   // built-in overdrive
  float s = (str + pk) * vel;
  outAudio = vec4(tanh(s), 0.0, 0.0, 1.0);
}
