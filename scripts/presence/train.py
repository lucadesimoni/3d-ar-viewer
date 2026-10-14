"""
Train the presence model and export it to ONNX.

    python scripts/presence/train.py <dataDir> <out.onnx> [--epochs 14]

Reads every `crops-*.u8` / `crops-*.jsonl` pair that `generate.mjs` wrote:
96 x 96 RGBA crops, the part's expected outline in alpha, labelled present or
absent. Holds out every tenth rendered view (whole views, so no view is on
both sides), trains a small CNN, and picks the two vote thresholds on the
held-out views:

  present  when p >= the lowest threshold whose "present" votes are 98% right
  absent   when p <= the highest threshold whose "absent" votes are 98% right
  between  no vote, as with the edge check (`perception/presence.ts`)

Writes the model, and `<out>.json` beside it with the thresholds and the
held-out numbers, which `docs/PRESENCE_MODEL.md` quotes.

The exported graph takes `input` float32 [N, 4, 96, 96] (RGB 0..1, outline 0/1;
`src/perception/presenceInput.ts`) and returns `present` float32 [N, 1], a
probability. Normalisation is inside the graph, so the app hands over the crop
exactly as it cut it.
"""
import argparse
import glob
import json
import os
import random
import time
import zlib

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

p = argparse.ArgumentParser()
p.add_argument('data')
p.add_argument('out')
p.add_argument('--epochs', type=int, default=14)
p.add_argument('--batch', type=int, default=128)
p.add_argument('--seed', type=int, default=7)
p.add_argument('--precision', type=float, default=0.98)
p.add_argument('--eval', help='a directory of crops kept apart and only scored: real frames')
args = p.parse_args()
torch.manual_seed(args.seed); np.random.seed(args.seed); random.seed(args.seed)
torch.set_num_threads(max(1, os.cpu_count() or 1))

# --- Data. -----------------------------------------------------------------------
def load(directory):
    xs, metas = [], []
    for path in sorted(glob.glob(os.path.join(directory, 'crops-*.u8'))):
        x = np.fromfile(path, dtype=np.uint8).reshape(-1, 96, 96, 4)
        meta = [json.loads(line) for line in open(path[:-3] + '.jsonl')]
        assert len(meta) == len(x), path
        xs.append(x); metas += meta
    return np.concatenate(xs), metas


x_all, metas = load(args.data)
y_all = np.array([m['present'] for m in metas], dtype=np.float32)
# Whole views held out; a report's views are strings, hashed stably (Python's own hash is salted per run).
held = np.array([(m['view'] if isinstance(m['view'], int) else zlib.crc32(str(m['view']).encode())) % 10 == 0 for m in metas])
print(f'{len(x_all)} crops, {y_all.mean():.1%} present; {held.sum()} held out')


def to_tensor(x):
    """Bytes, channels first. Kept as bytes: 40,000 crops as float32 are 6 GB."""
    return torch.from_numpy(np.ascontiguousarray(x)).permute(0, 3, 1, 2)


def as_input(b):
    """A batch of byte crops as the model's input: RGB 0..1, outline 0 or 1."""
    t = b.float() / 255.0
    t[:, 3] = (t[:, 3] > 0.5).float()
    return t


x_train, y_train = to_tensor(x_all[~held]), torch.from_numpy(y_all[~held])
x_val, y_val = to_tensor(x_all[held]), torch.from_numpy(y_all[held])
del x_all
val_meta = [m for m, h in zip(metas, held) if h]


def augment(b):
    """What a real frame does that the renders did not: flips, shifts, colour casts, something in front."""
    n = b.shape[0]
    flip = torch.rand(n) < 0.5
    b[flip] = b[flip].flip(3)
    # Shift image and outline together: a crop is cut where the outline is, so they move as one.
    dx, dy = random.randint(-6, 6), random.randint(-6, 6)
    b = torch.roll(b, shifts=(dy, dx), dims=(2, 3))
    rgb = b[:, :3]
    gain = 1 + 0.25 * (torch.rand(n, 3, 1, 1) - 0.5)
    bias = 0.08 * (torch.rand(n, 1, 1, 1) - 0.5)
    rgb = (rgb * gain + bias).clamp(0, 1)
    gray = rgb.mean(1, keepdim=True)
    sat = 1 + 0.6 * (torch.rand(n, 1, 1, 1) - 0.5)
    rgb = (gray + (rgb - gray) * sat).clamp(0, 1)
    # Occluders: a hand, a cable, a tool across part of the crop.
    for i in torch.nonzero(torch.rand(n) < 0.3).flatten().tolist():
        w, h = random.randint(8, 40), random.randint(8, 40)
        x0, y0 = random.randint(0, 96 - w), random.randint(0, 96 - h)
        rgb[i, :, y0:y0 + h, x0:x0 + w] = torch.rand(3, 1, 1)
    return torch.cat([rgb, b[:, 3:]], 1)


# --- Model. ----------------------------------------------------------------------
def block(cin, cout, stride):
    return nn.Sequential(
        nn.Conv2d(cin, cin, 3, stride, 1, groups=cin, bias=False), nn.BatchNorm2d(cin), nn.ReLU(inplace=True),
        nn.Conv2d(cin, cout, 1, bias=False), nn.BatchNorm2d(cout), nn.ReLU(inplace=True),
    )


class Presence(nn.Module):
    def __init__(self):
        super().__init__()
        self.stem = nn.Sequential(nn.Conv2d(4, 24, 3, 2, 1, bias=False), nn.BatchNorm2d(24), nn.ReLU(inplace=True))  # 48
        self.body = nn.Sequential(
            block(24, 32, 1), block(32, 48, 2),    # 24
            block(48, 48, 1), block(48, 64, 2),    # 12
            block(64, 64, 1), block(64, 96, 2),    # 6
            block(96, 128, 1),
        )
        self.head = nn.Linear(128, 1)

    def forward(self, x):
        rgb = (x[:, :3] - 0.5) / 0.25
        mask = x[:, 3:] * 2 - 1
        z = self.body(self.stem(torch.cat([rgb, mask], 1)))
        return self.head(F.adaptive_avg_pool2d(z, 1).flatten(1))


class Exported(nn.Module):
    """The app's graph: a probability out, nothing else to know."""
    def __init__(self, net):
        super().__init__()
        self.net = net

    def forward(self, input):  # noqa: A002 - the ONNX input's name
        return torch.sigmoid(self.net(input))


net = Presence()
params = sum(p.numel() for p in net.parameters())
print(f'{params} parameters')
opt = torch.optim.AdamW(net.parameters(), lr=3e-3, weight_decay=1e-4)
steps = args.epochs * ((len(x_train) + args.batch - 1) // args.batch)
sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=3e-3, total_steps=steps)


def predict(x):
    net.eval()
    out = []
    with torch.no_grad():
        for i in range(0, len(x), 512):
            out.append(torch.sigmoid(net(as_input(x[i:i + 512]))).flatten())
    return torch.cat(out).numpy()


for epoch in range(args.epochs):
    net.train()
    t0 = time.time()
    order = torch.randperm(len(x_train))
    total = 0.0
    for i in range(0, len(order), args.batch):
        idx = order[i:i + args.batch]
        b = augment(as_input(x_train[idx]))
        loss = F.binary_cross_entropy_with_logits(net(b).flatten(), y_train[idx])
        opt.zero_grad(); loss.backward(); opt.step(); sched.step()
        total += loss.item() * len(idx)
    pv = predict(x_val)
    acc = ((pv >= 0.5) == (y_val.numpy() > 0.5)).mean()
    print(f'epoch {epoch + 1}/{args.epochs}: loss {total / len(x_train):.4f}, held-out accuracy {acc:.3f}, {time.time() - t0:.0f}s', flush=True)

# --- Thresholds and the held-out numbers. ----------------------------------------
pv = predict(x_val)
yv = y_val.numpy() > 0.5


def thresholds(p, y, precision):
    hi = 1.0
    for t in np.linspace(0.5, 0.99, 50):
        sel = p >= t
        if sel.sum() >= 20 and y[sel].mean() >= precision:
            hi = float(t); break
    lo = 0.0
    for t in np.linspace(0.5, 0.01, 50):
        sel = p <= t
        if sel.sum() >= 20 and (~y[sel]).mean() >= precision:
            lo = float(t); break
    return hi, lo


hi, lo = thresholds(pv, yv, args.precision)
votes_present = pv >= hi
votes_absent = pv <= lo


def share(mask, of):
    """Mean of `of` over `mask`, 0 when the mask is empty rather than NaN, which JSON cannot hold."""
    return round(float(of[mask].mean()), 4) if mask.any() else 0.0

report = {
    'input': [4, 96, 96], 'parameters': params, 'epochs': args.epochs,
    'train_crops': int(len(x_train)), 'heldout_crops': int(len(x_val)),
    'thresholds': {'present': round(hi, 3), 'absent': round(lo, 3)},
    'heldout': {
        'accuracy_at_0.5': round(float(((pv >= 0.5) == yv).mean()), 4),
        'present_vote_precision': share(votes_present, yv),
        'absent_vote_precision': share(votes_absent, ~yv),
        'share_voting': round(float((votes_present | votes_absent).mean()), 4),
        'present_recall': share(yv, votes_present),
        'absent_recall': share(~yv, votes_absent),
    },
    'by_assembly': {},
}
for a in sorted({m['assembly'] for m in val_meta}):
    sel = np.array([m['assembly'] == a for m in val_meta])
    report['by_assembly'][a] = {'crops': int(sel.sum()), 'accuracy_at_0.5': round(float(((pv[sel] >= 0.5) == yv[sel]).mean()), 4)}
if args.eval:
    x_ext, m_ext = load(args.eval)
    p_ext = predict(to_tensor(x_ext))
    y_ext = np.array([m['present'] for m in m_ext])
    v_ext = [modelvote for modelvote in (('present' if q >= hi else 'absent' if q <= lo else None) for q in p_ext)]
    right = sum(1 for v, y in zip(v_ext, y_ext) if v is not None and (v == 'present') == y)
    voted = sum(1 for v in v_ext if v is not None)
    report['external'] = {
        'crops': int(len(x_ext)), 'present': int(y_ext.sum()),
        'accuracy_at_0.5': round(float(((p_ext >= 0.5) == y_ext).mean()), 4),
        'votes': voted, 'votes_right': right,
        'scores': [{'part': m['partId'], 'present': bool(m['present']), 'p': round(float(q), 3)} for m, q in zip(m_ext, p_ext)],
    }
print(json.dumps({k: v for k, v in report.items() if k != 'external'}, indent=2))
if 'external' in report:
    e = report['external']
    print(f"external: {e['crops']} crops ({e['present']} present), accuracy at 0.5 {e['accuracy_at_0.5']}, votes {e['votes']} of which right {e['votes_right']}")
    for s_ in e['scores']:
        print(f"  {'P' if s_['present'] else 'A'} {s_['p']:.3f} {s_['part']}")

net.eval()
torch.onnx.export(
    Exported(net), torch.zeros(1, 4, 96, 96), args.out,
    input_names=['input'], output_names=['present'],
    dynamic_axes={'input': {0: 'n'}, 'present': {0: 'n'}}, opset_version=17, dynamo=False,
)
json.dump(report, open(args.out + '.json', 'w'), indent=2)
print(f'wrote {args.out} ({os.path.getsize(args.out) // 1024} KB)')
