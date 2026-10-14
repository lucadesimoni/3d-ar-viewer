# Lining the overlay up with the real object

Two things put the overlay on the object in AR:

- **The shelf detector** (`src/vision/objectAnchor.ts`, `gridRecognition.ts`)
  finds a KALLAX from nothing, by its grid of cells. It works only for
  assemblies with a recognition target, and only the KALLAX has one.
- **Registration** (`src/perception/register.ts`) works for every assembly. It
  starts from wherever the overlay is (a tap on the floor, a WebXR anchor, the
  shelf detector's lock) and moves it until the parts' edges sit on edges in
  the camera picture.

## How registration works

1. **The model.** Every part's shape becomes edges, in the assembly's frame.
   Edges come in two kinds:
   - *creases*: a box's corners, a plate's bore, a cylinder's rims. A crease
     shows wherever a face beside it is seen.
   - *smooth edges*: along a cylinder's side, across a sphere. A smooth edge
     shows only on the outline, where one face turns towards the camera and
     the other away.

   Parts built from a primitive have exact edges. A part loaded from a file
   gets its edges from its triangles (`edgesFromTriangles`, via
   `SceneManager.partEdges`). Only parts already built (the ticked steps') are
   matched; with nothing ticked, all of them, for a finished object being
   checked. Points along the edges are sampled about every 4 cm, at most
   1,200 in all.
2. **What the camera sees.** At each pose, a sample counts only if its edge
   shows from the camera and no other part's box stands in front of it.
3. **The fit.** Each visible sample is projected into the picture. The
   picture is then searched across the edge (not along it) for the strongest
   gradient running the same way. The pose is solved by iteratively
   reweighted least squares, with Tukey weights, so clutter, a hand or a part
   not fitted yet cannot pull it. The search runs coarse to fine: 32, 20, 12
   and 7 px windows, the wide ones on a blurred copy of the picture, so a
   board's edge leads and a basket's weave does not.
4. **What may move.** Only what a thing standing on the floor can move: across
   the floor, and turning about the vertical. Height and tilt come from the
   platform's floor and gravity. A weak pull back to the start keeps what the
   picture cannot show (a round tank's turn) where it was.

## When the fit is used

It is used only if all of these hold, and otherwise the overlay stays where
it was:

| Check | Why |
|---|---|
| At least 45% of the visible samples are on an edge within 3 px | A fit no better than that is not convincing |
| And 3 points more than at the start | Otherwise there is nothing to gain from moving |
| At least 30% in each quarter of the outline | A fit turned or slid the wrong way sits on one side only |
| No other pose nearby agrees within 6 points, unless its edges land within 6 px of this one's | A shelf's cells repeat: a fit one cell out agrees with most of the picture |
| It keeps 60% of what was in view, moved at most 30 cm (half the object's size, for a small one) and turned at most 20° | Further, and it has found something else |

The rival check refines the pose from 18 starts around the fit: 8, 16, 28 and
40 cm along the object's width and depth, and 6° and 12° either way. A better
rival is taken; one nearly as good means the picture does not say which is
right.

## In the app

`alignAnchor` in `src/components/useArController.ts` looks every 1.5 s, or
every 3 s once it holds the object. It skips blurred frames, an exploded view
and placement in progress. While it holds the object, the shelf detector does
not move the overlay: registration is the finer of the two, and two hands on
one anchor would make it flicker. After three looks in a row without the
object, it lets go.

In AR settings it is "Line the overlay up with the real object", on by
default. Every look is in the diagnostics log:

- `alignment moved the overlay`: by how many pixels and centimetres;
- `alignment look`: the outcome (`on the object`, or why not: `weak-fit`,
  `lopsided`, `ambiguous`, `too-few-visible`, `moved-too-far`,
  `no-improvement`).

Each entry carries the agreement before and after, the weakest quarter, the
best rival, the samples in view and the milliseconds taken.

## How good it is

### Rendered views

`npm run recognition:bench` (`scripts/recognition/bench.mjs`) renders every
sample assembly, fully built, with the presence model's synthetic renderer.
The truth is known exactly. Views:

- straight on, and 35° to either side;
- 10° and 30° above;
- near and far;
- with and without clutter.

Each view also gets random rooms, light, finishes, and phone noise, blur and
JPEG. From each view, registration starts from 8 poses 5, 10 and 20 cm and
up to 15° off the truth.

BENCH_TABLE

*Good* means the model's edges within 3 px of the truth, under 1.5° and
within 5 cm. Along the line of sight a few centimetres barely change the
picture, so the pixels are what the operator sees. *False* means accepted
while more than 6 px off: visibly wrong. Timings are headless Chromium on a
CI-class CPU.

What this says:

- On the shelves, the engine and the rack, registration lands within a pixel
  or two, and refuses rather than lands wrong.
- **Its reach is about 20 to 30 px.** The gearbox is small: a 10 cm error on
  it is 40 px, out of reach, so it is mostly refused. A tap that is that far
  off has to be redone by hand.
- **Depth is its weakest direction.** Square on, moving a few centimetres
  nearer or further hardly changes the picture. The overlay looks right while
  being 1 to 3 cm out in depth.

### The shelf detector on the same views

GRID_TABLE

On rendered views the shelf detector is the weak link. It locks on about half
the views, and its locks are typically 7 to 20 cm and several degrees out:
often outside registration's reach.

### Real frames

There are six device photos of real KALLAX shelves, with the camera pose the
phone reported. They are kept out of the repository.

- The shelf detector locks on four of the six.
- **Registration refused on all four locks.** Even the best pose from a brute
  force search over the floor (±45 cm, ±24°) agrees only 31 to 43%, and is
  visibly not on the shelf.
- So on these frames no upright pose on the floor fits. Registration did
  right to refuse; the error lies in something it takes as given:
  - the phone's reported camera pose at the moment of the frame;
  - the field of view;
  - or the floor height.

  Telling which needs a device session: the log now records every look.

## What is not done

- **No detection from nothing for assemblies other than the KALLAX.**
  Registration refines a placement; it does not search the room.
- **Main thread.** A look takes 30 to 180 ms on the benchmark machine, once
  every 1.5 to 3 s, on the main thread. On a slow phone that is a visible
  hitch every few seconds. A worker would remove it.
- **Not yet measured on a device.**
