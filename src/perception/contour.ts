import type { Obb } from '../engine/collision';
import type { CameraIntrinsics } from './intrinsics';
import { NEAR_M, obbCorners, projectToImage, toViewSpace } from './roi';
import type { Point2 } from './agreement';

/**
 * A part's own silhouette in the frame, not a facade drawn by hand.
 *
 * `agreement.ts` needs an outline to walk. For the KALLAX facade that outline
 * was four points typed by hand from the recognition target's known geometry.
 * A single part's oriented box, seen from anywhere but straight on, projects
 * to a hexagon — the near face's four corners plus up to two more where a far
 * edge peeks past a near one — and a caller that only knew rectangles would
 * have to either lie about the shape or throw away real edge material at the
 * corners `agreement.ts` most wants to sample.
 *
 * The box, not the mesh, is the named approximation here: convex, cheap, and
 * already computed for the ROI (`roi.ts`'s `obbCorners`). A part with a
 * genuinely concave silhouette (an L-bracket, say) would still resolve to a
 * smaller-than-true contour — an approximation, not a lie, since the walked
 * outline stays fully inside the part's own image footprint.
 */

export interface PartContour {
  /** The convex hull of the box's visible corners, in image pixels. */
  hull: Point2[];
  /** How many of the box's 8 corners were behind the camera and dropped. */
  droppedCorners: number;
}

function cross(o: Point2, a: Point2, b: Point2): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/**
 * Andrew's monotone chain. Nothing like it exists in this repo yet — every
 * other silhouette in the codebase was either a hand-typed rectangle or an
 * axis-aligned bounding box (`roi.ts`'s own `roiForCorners`), neither of
 * which needs a hull.
 */
function convexHull(points: Point2[]): Point2[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const n = pts.length;
  if (n < 3) return pts;

  const hull: Point2[] = [];
  for (const p of pts) {
    while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) {
      hull.pop();
    }
    hull.push(p);
  }
  const lowerLen = hull.length + 1;
  for (let i = n - 2; i >= 0; i--) {
    const p = pts[i];
    while (hull.length >= lowerLen && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) {
      hull.pop();
    }
    hull.push(p);
  }
  hull.pop(); // Closes back on the first point; drop the repeat.
  return hull;
}

/**
 * The outline a part's box implies in the current frame, or `undefined` when
 * fewer than three of its corners are in front of the camera — the same
 * near-plane rule `roi.ts` uses internally for its rectangle, so a part right
 * at the camera does not get mirrored through the lens into a confidently
 * wrong contour.
 */
export function partContour(
  obb: Obb,
  viewMatrix: ArrayLike<number>,
  k: CameraIntrinsics,
): PartContour | undefined {
  const viewCorners = obbCorners(obb).map((c) => toViewSpace(c, viewMatrix));
  const inFront = viewCorners.filter((c) => c.z > NEAR_M);
  if (inFront.length < 3) return undefined;

  const points = inFront.map((c) => {
    const { u, v } = projectToImage(c, k);
    return { x: u, y: v };
  });
  return { hull: convexHull(points), droppedCorners: viewCorners.length - inFront.length };
}
