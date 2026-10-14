# The presence model

`src/perception/models/presence-v1.onnx` answers one question for the AR step
check: **is this part in place?** It is the trained half of the presence check.
The other half is the edge check in `src/perception/presence.ts`.

## What it is shown, and what it says

For each part of the active step, the app projects the part's box through the
anchor and cuts a square of the camera frame around its outline: 96 × 96
pixels, with a quarter of the outline's size as context on each side
(`src/perception/presenceInput.ts`). The model gets four channels: red, green
and blue, plus the expected outline filled in. It returns p(present).

It is not told which part it is looking at, only where the part should be. So
one model serves every part of every assembly. A per-part classifier would
need training images of each part.

Two thresholds, chosen on held-out data and shipped in
`presence-v1.onnx.json`, turn p into a vote:

- p ≥ the *present* threshold votes "in place";
- p ≤ the *absent* threshold votes "not in place";
- anything between is no vote.

A vote is folded into the same hysteresis as the edge check
(`src/perception/evidence.ts`): three agreeing looks in a row change the
state.

**It never decides alone.** The edge check was measured on a real session; the
model has mostly seen renders. A model vote counts only where the edge check
does not contradict it (`combineVotes`):

- both agree: the vote counts;
- one is silent: the other's vote counts;
- they contradict: no vote.

The edge check is silent across the middle of its range, which is where most
real frames sit, so this is where the model adds evidence. Every look logs
both readings (`part presence` in the diagnostics log), so device sessions can
show which reader to trust more.

The step guide shows each part as seen or not seen. It shows the step as
"every part looks in place" or "N of M not in place yet". The step guide calls
this a suggestion: the operator still ticks the step.

## How it was trained

`scripts/presence/`:

1. **`generate.mjs`** renders KALLAX shelves (and, a fifth of the time, the
   other sample assemblies) part-way through their build, in headless
   Chromium, with the app's own Babylon code. Randomised:
   - the board finish (white most often);
   - the floor, the walls and the light, with and without shadows;
   - clutter in the cubes and around the shelf;
   - where the phone is, and its field of view;
   - what a phone camera does to a picture: noise, blur, exposure, JPEG.

   Each crop is cut by the app's own code through a pose made deliberately
   wrong. Half the views use about 1 cm and 1°; half use about 3 cm and 3°,
   the error real locks were seen to have. So the training crops are the
   crops the app cuts at runtime, misalignment included. The label is whether
   the part was rendered.
2. **`train.py`** trains a small depthwise-separable CNN in PyTorch on CPU and
   exports ONNX (opset 17). It holds out every tenth rendered view: whole
   views, never crops from a view seen in training. It picks the two
   thresholds on those held-out views, for 98% precision each way.
3. **`crops-from-report.mjs`** cuts the same crops from diagnostics reports
   sent from devices. Captures now record each part's outline and whether its
   step was ticked. This is how real training data accumulates.

```bash
node scripts/presence/generate.mjs data --views=8000 --pages=4     # ~75 min on 4 cores
python -m venv venv && venv/bin/pip install -r scripts/presence/requirements.txt
venv/bin/python scripts/presence/train.py data src/perception/models/presence-v1.onnx --eval real-crops
```

## How good it is

**The model.** A small depthwise-separable CNN, trained from scratch: no
pretrained weights. It has 36,345 parameters and is 147 KB as ONNX. It was
trained on 39,259 synthetic crops (14 epochs, CPU) and tested on 3,861
crops from 800 rendered views it never saw.

**On held-out renders**, every assembly together:

| | |
|---|---|
| Accuracy at p = 0.5 | 96.9% (KALLAX 4x2: 98.3%, 4x4: 97.3%) |
| At the shipped thresholds (present ≥ 0.9, absent ≤ 0.1) | votes on 91.1% of crops |
| Of its "present" votes | 99.4% right |
| Of its "absent" votes | 99.0% right |

**On real frames**, the only real data there is: 19 crops from two device
photos of a finished KALLAX 4x2, cut through the app's own recognition lock.
15 crops are parts that are there. 4 are the top row of a 4x4 projected onto
the wall above the 4x2, so nothing is there. None were used for training.

| Thresholds | Votes | Wrong |
|---|---|---|
| 0.64 / 0.31, picked on renders for 98% precision | 19 | 3 |
| **0.9 / 0.1, shipped** | **10** | **0** |

The thresholds were tightened for that reason: at the renders' own choice,
the model was confidently wrong on 3 of 19 real crops. Abstaining more is
the safe way to be unsure, because a wrong "not in place" is what an operator
would act on. Nineteen crops of one shelf in one room is a sanity check, not
a measurement. The real error rate is unknown until device sessions supply
more (see below).

`presence-v1.onnx.json` carries all of this beside the model.

## What it cannot do yet

- **It has not been measured on a real build in progress.** Every real crop
  above is of a finished shelf or of empty wall. A real "shelf not fitted yet"
  has never been shown to it. That is the first thing a device session should
  collect:
  1. tick steps as they are done;
  2. attach camera frames from the AR settings;
  3. send the diagnostics log;
  4. run `crops-from-report.mjs`.

  Retraining with those crops in the data directory takes minutes.
- **Only KALLAX is checked in the app.** Presence runs for assemblies with a
  recognition target, and only the KALLAX has one. The model was trained on
  the other samples too, so it is ready when they get one.
- **Wrong part, not just missing part:** it says whether something is where
  the part should be, not whether it is the right part. A wrong board in the
  right slot reads as present.
- **The anchor still matters most.** A lock a row off asks about the wrong
  region. The model was trained on misaligned outlines up to about 8 cm, not on
  locks a whole cell off.

## Switching it off

Build with `VITE_PRESENCE_MODEL=off`, and the edge check works alone, as
before. The Mendix widget never includes the model.
