// Analysis Situs ops of the kernel facade (asi_ops.hpp). The only source file compiled with
// Analysis Situs' include paths and kernel-build/asi/asi_occt79_compat.h force-included
// (build-facade.sh). Nothing here keeps state between calls: every AAG is made, used and
// freed inside one call.
// SPDX-License-Identifier: GPL-3.0-or-later

#include "asi_ops.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <map>
#include <set>
#include <unordered_map>

#include <BRepAdaptor_Surface.hxx>
#include <BRepBndLib.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepExtrema_DistShapeShape.hxx>
#include <BRepLProp_SLProps.hxx>
#include <BRepTools.hxx>
#include <BRep_Tool.hxx>
#include <Bnd_Box.hxx>
#include <Standard_Failure.hxx>
#include <Standard_OutOfMemory.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopTools_ListIteratorOfListOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <gp_Cylinder.hxx>
#include <gp_Lin.hxx>
#include <gp_Sphere.hxx>
#include <gp_Torus.hxx>
#include <gp_Cone.hxx>

#include <asiAlgo_AAG.h>
#include <asiAlgo_AttrBlendCandidate.h>
#include <asiAlgo_History.h>
#include <asiAlgo_RecognizeBlends.h>
#include <asiAlgo_RecognizeDrillHoles.h>
#include <asiAlgo_SuppressBlendsInc.h>

namespace mkasi {
namespace {

double nowMs() {
  using namespace std::chrono;
  return duration<double, std::milli>(steady_clock::now().time_since_epoch()).count();
}

Refusal done() { return Refusal(); }
Refusal refuse(const char* code, const std::string& words) {
  Refusal r;
  r.code = code;
  r.words = words;
  return r;
}

// A radius in words: R2, R1.5, R0.432.
std::string num(double v) {
  char b[32];
  std::snprintf(b, sizeof b, "%.4g", v);
  return b;
}

// An Analysis Situs failure that is not running out of memory becomes words; running out of
// memory goes on to mk_call, which reports it as such (low_memory when the heap is full).
template <class F>
Refusal guarded(const char* what, F&& f) {
  try {
    return f();
  } catch (const Standard_OutOfMemory&) {
    throw;
  } catch (const Standard_Failure& e) {
    const char* m = e.GetMessageString();
    return refuse("occt", std::string(what) + " failed (" + e.DynamicType()->Name() + (m && *m ? std::string(": ") + m : std::string()) + ")");
  }
}

double diagonalOf(const TopoDS_Shape& s) {
  Bnd_Box b;
  BRepBndLib::Add(s, b, false);
  return b.IsVoid() ? 0. : std::sqrt(b.SquareExtent());
}

// AAG face ids (1-based, TopExp::MapShapes order of the solid) to 0-based indices of the body's
// face map. A face that is not found, or found as another face, is an internal error: never a
// wrong index.
bool mapIds(const Handle(asiAlgo_AAG)& aag, const TopTools_IndexedMapOfShape& bodyFaces, std::vector<int>& toBody,
            Refusal& err) {
  const TopTools_IndexedMapOfShape& m = aag->GetMapOfFaces();
  toBody.assign(m.Extent() + 1, -1);
  for (int i = 1; i <= m.Extent(); ++i) {
    const int k = bodyFaces.FindIndex(m(i));
    if (k < 1 || !bodyFaces(k).IsSame(m(i))) {
      err = refuse("internal", "internal: Analysis Situs face " + std::to_string(i) + " is not a face of the body");
      return false;
    }
    toBody[i] = k - 1;
  }
  return true;
}

// The fillet radius of a face: exact for analytic blends, otherwise 1 / the largest principal
// curvature sampled over a 5 x 5 grid of the face's UV box (ends included, so a 2 -> 6 variable
// fillet reads 2 and 6; Analysis Situs samples once).
void radiiOf(const TopoDS_Face& f, double& rmin, double& rmax) {
  rmin = rmax = 0;
  BRepAdaptor_Surface sa(f, true);
  switch (sa.GetType()) {
    case GeomAbs_Cylinder: rmin = rmax = sa.Cylinder().Radius(); return;
    case GeomAbs_Torus: rmin = rmax = sa.Torus().MinorRadius(); return;
    case GeomAbs_Sphere: rmin = rmax = sa.Sphere().Radius(); return;
    default: break;
  }
  double u0, u1, v0, v1;
  BRepTools::UVBounds(f, u0, u1, v0, v1);
  BRepLProp_SLProps p(sa, 2, 1e-9);
  static const double kAt[] = {0.0, 0.25, 0.5, 0.75, 1.0};
  bool any = false;
  for (double fu : kAt)
    for (double fv : kAt) {
      p.SetParameters(u0 + fu * (u1 - u0), v0 + fv * (v1 - v0));
      if (!p.IsCurvatureDefined()) continue;
      const double k = std::max(std::fabs(p.MaxCurvature()), std::fabs(p.MinCurvature()));
      if (!(k > 1e-12)) continue;
      const double r = 1. / k;
      if (!any || r < rmin) rmin = r;
      if (!any || r > rmax) rmax = r;
      any = true;
    }
}

const char* kindName(asiAlgo_BlendType k) {
  switch (k) {
    case BlendType_Ordinary: return "ordinary";
    case BlendType_Vertex: return "vertex";
    case BlendType_Cliff: return "cliff";
    default: return "uncertain";
  }
}

std::vector<int> sortedIds(const TColStd_PackedMapOfInteger& m, const std::vector<int>& toBody) {
  std::vector<int> v;
  for (TColStd_MapIteratorOfPackedMapOfInteger it(m); it.More(); it.Next()) v.push_back(toBody[it.Key()]);
  std::sort(v.begin(), v.end());
  v.erase(std::unique(v.begin(), v.end()), v.end());
  return v;
}

// Fillets of one solid. Faces are appended with body indices; chains are kept with their faces
// (chain ids are given after everything is sorted).
Refusal blendsOf(const TopoDS_Shape& solid, const TopTools_IndexedMapOfShape& bodyFaces, double radius,
                 Recognition& out, std::vector<Chain>& chains) {
  double t0 = nowMs();
  Handle(asiAlgo_AAG) aag = new asiAlgo_AAG(solid, false);
  out.aag_ms += nowMs() - t0;
  std::vector<int> toBody;
  Refusal err;
  if (!mapIds(aag, bodyFaces, toBody, err)) return err;
  t0 = nowMs();
  asiAlgo_RecognizeBlends rb(aag);
  if (!rb.Perform(radius)) return refuse("occt", "fillet recognition failed");
  for (TColStd_MapIteratorOfPackedMapOfInteger it(rb.GetResultIndices()); it.More(); it.Next()) {
    const int fid = it.Key();
    Handle(asiAlgo_AttrBlendCandidate) a = aag->ATTR_NODE<asiAlgo_AttrBlendCandidate>(fid);
    Blend b;
    b.face = toBody[fid];
    if (a.IsNull()) {
      b.kind = "uncertain";
    } else {
      b.kind = kindName(a->Kind);
      b.r = a->Radii.empty() ? 0. : a->GetMaxRadius();
      int nConvex = 0, nConcave = 0;
      for (asiAlgo_BlendVexity v : a->Vexities) {
        if (v == BlendVexity_Convex) ++nConvex;
        else if (v == BlendVexity_Concave) ++nConcave;
      }
      const int n = (int)a->Vexities.size();
      b.convex = n > 0 && nConvex == n ? 1 : n > 0 && nConcave == n ? 0 : -1;
    }
    radiiOf(TopoDS::Face(aag->GetFace(fid)), b.r_min, b.r_max);
    out.blends.push_back(b);
  }
  std::vector<asiAlgo_BlendChain> raw;
  rb.GetChains(raw);
  for (const asiAlgo_BlendChain& c : raw) {
    Chain ch;
    ch.faces = sortedIds(c.first, toBody);
    if (ch.faces.empty()) continue;
    ch.length = c.second.Length;
    chains.push_back(ch);
  }
  out.blends_ms += nowMs() - t0;
  return done();
}

// Does the face touch the infinite line? (A face of a hole that closes its axis: a flat or
// pointed bottom; a counterbore's step or a countersink keeps the axis open.)
bool touchesAxis(const TopoDS_Face& f, const gp_Ax1& axis, double halfLength, double tol) {
  const gp_Pnt a = axis.Location().Translated(gp_Vec(axis.Direction()) * -halfLength);
  const gp_Pnt b = axis.Location().Translated(gp_Vec(axis.Direction()) * halfLength);
  BRepBuilderAPI_MakeEdge me(a, b);
  if (!me.IsDone()) return false;
  BRepExtrema_DistShapeShape d(me.Edge(), f);
  return d.IsDone() && d.NbSolution() > 0 && d.Value() <= tol;
}

Refusal holesOf(const TopoDS_Shape& solid, const TopTools_IndexedMapOfShape& bodyFaces, bool hard, double diag,
                Recognition& out) {
  double t0 = nowMs();
  Handle(asiAlgo_AAG) aag = new asiAlgo_AAG(solid, false);
  out.aag_ms += nowMs() - t0;
  std::vector<int> toBody;
  Refusal err;
  if (!mapIds(aag, bodyFaces, toBody, err)) return err;
  t0 = nowMs();
  asiAlgo_RecognizeDrillHoles rh(aag, hard);
  if (!rh.Perform()) return refuse("occt", "hole recognition failed");
  std::vector<asiAlgo_Feature> comps;
  if (rh.GetResultIndices().Extent()) aag->GetConnectedComponents(rh.GetResultIndices(), comps);
  for (const asiAlgo_Feature& comp : comps) {
    Hole h;
    h.faces = sortedIds(comp, toBody);
    if (h.faces.empty()) continue;
    // The bore: every cylinder of the hole; its axis is the narrowest cylinder's (a cone's when
    // the hole has no cylinder).
    bool haveAxis = false;
    gp_Ax1 axis;
    double rAxis = 0;
    std::vector<TopoDS_Face> others;
    for (asiAlgo_Feature::Iterator it(comp); it.More(); it.Next()) {
      const TopoDS_Face face = TopoDS::Face(aag->GetFace(it.Key()));
      BRepAdaptor_Surface sa(face, false);
      if (sa.GetType() == GeomAbs_Cylinder) {
        const double r = sa.Cylinder().Radius();
        if (!h.sized || 2 * r < h.d_min) h.d_min = 2 * r;
        if (!h.sized || 2 * r > h.d_max) h.d_max = 2 * r;
        if (!haveAxis || r < rAxis) {
          axis = sa.Cylinder().Axis();
          rAxis = r;
        }
        haveAxis = true;
        h.sized = true;
      } else {
        others.push_back(face);
      }
    }
    if (!haveAxis)
      for (const TopoDS_Face& face : others) {
        BRepAdaptor_Surface sa(face, false);
        if (sa.GetType() == GeomAbs_Cone) {
          axis = sa.Cone().Axis();
          haveAxis = true;
          break;
        }
      }
    h.through = haveAxis;
    if (haveAxis) {
      const double tol = std::max(1e-6, 1e-4 * (rAxis > 0 ? rAxis : 1.));
      for (const TopoDS_Face& face : others)
        if (touchesAxis(face, axis, 2. * diag + 1., tol)) {
          h.through = false;
          break;
        }
    }
    out.holes.push_back(h);
  }
  out.holes_ms += nowMs() - t0;
  return done();
}

// Why fillets stayed, in words: a closed ring (a face with a seam, such as the torus round a boss
// or a hole) is never taken off by SuppressBlendsInc; anything else is said as what happened.
std::string whyLeft(const TopTools_IndexedMapOfShape& solidFaces, const std::vector<int>& idx) {
  int rings = 0;
  for (int i : idx) {
    const TopoDS_Face& f = TopoDS::Face(solidFaces(i));
    for (TopExp_Explorer ex(f, TopAbs_EDGE); ex.More(); ex.Next())
      if (BRep_Tool::IsClosed(TopoDS::Edge(ex.Current()), f)) {
        ++rings;
        break;
      }
  }
  if (!idx.empty() && rings == (int)idx.size()) return "(a ring round a boss or a hole cannot be taken off as a fillet)";
  return "(the faces around them could not be rebuilt)";
}

// ------------------------------------------------------------- run-time budget ---

// 1,234 and 12,345.
std::string commas(long long n) {
  std::string d = std::to_string(n < 0 ? -n : n), o;
  for (size_t i = 0; i < d.size(); ++i) {
    if (i && (d.size() - i) % 3 == 0) o += ',';
    o += d[i];
  }
  return n < 0 ? "-" + o : o;
}

// A predicted time in words: one decimal below 10 s ("about 0.4 s", "about 2.0 s", "about 6.8 s"),
// then to 5 s ("about 30 s") and in minutes ("about 3 min"). A prediction over `overMs` never reads
// at or under it: one that rounds down to it reads the next tenth over it (1.42 s over 1.4 s reads
// "about 1.5 s"), so a refusal never says "about 1.4 s; ... allows 1.4 s".
std::string aboutTime(double ms, double overMs) {
  long tenths = std::max(1L, std::lround(ms / 100.));
  if (ms > overMs && tenths * 100. <= overMs) tenths = (long)std::floor(overMs / 100.) + 1;
  if (tenths < 100) {
    char b[24];
    std::snprintf(b, sizeof b, "%ld.%ld", tenths / 10, tenths % 10);
    return std::string("about ") + b + " s";
  }
  const double s = ms / 1000.;
  if (s < 92.5) return "about " + std::to_string(std::max(10, 5 * (int)std::lround(s / 5.))) + " s";
  return "about " + std::to_string(std::max(2, (int)std::lround(s / 60.))) + " min";
}

// A budget in seconds, as short as it is exact to the millisecond: "1.4 s", "0.35 s", "0.01 s".
std::string secondsText(double ms) {
  char b[32];
  std::snprintf(b, sizeof b, "%.3f", std::max(0., ms) / 1000.);
  std::string t = b;
  while (t.size() > 1 && t.back() == '0') t.pop_back();
  if (!t.empty() && t.back() == '.') t.pop_back();
  return t + " s";
}

bool freeForm(const TopoDS_Face& f) {
  switch (BRepAdaptor_Surface(f, false).GetType()) {
    case GeomAbs_Plane:
    case GeomAbs_Cylinder:
    case GeomAbs_Cone:
    case GeomAbs_Sphere:
    case GeomAbs_Torus: return false;
    default: return true;
  }
}

// The counts SuppressBlendsInc's run time is predicted from, in one pass over the solid's edges
// (faces are 1-based indices of the solid's face map).
//  - pair_work: the work of one adjacency-graph build. asiAlgo_CheckDihedralAngle compares the
//    two faces' edges in a double loop for every adjacent pair (it copied both faces' edge maps
//    too before the speed hunk in asi-occt79-wasm.patch), so a pair of faces with e1 and e2 edges
//    costs about e1 * e2 + e1 + e2.
//  - pair_work_after: the same once the picked faces are gone (each kept face loses the edges it
//    shares with picks): the graph is rebuilt after every chain, on a body that shrinks.
//  - free_form_chains: chains at R with a face that is not a plane, cylinder, cone, sphere or
//    torus in them or next to them (rebuilding those edges intersects B-splines);
//    free_form_picks: picked faces of that kind.
struct CostCounts {
  double pairWork = 0, pairWorkAfter = 0;
  int freeChains = 0, freePicks = 0;
};

CostCounts costCounts(const TopoDS_Shape& solid, const TopTools_IndexedMapOfShape& solidFaces, const std::vector<bool>& picked,
                      const std::vector<std::vector<int>>& chains) {
  CostCounts c;
  const int n = solidFaces.Extent();
  TopTools_IndexedDataMapOfShapeListOfShape ef;
  TopExp::MapShapesAndUniqueAncestors(solid, TopAbs_EDGE, TopAbs_FACE, ef);
  std::vector<double> e(n + 1, 0.), lost(n + 1, 0.);
  std::vector<std::pair<int, int>> pairs;
  std::vector<int> fs;
  for (int i = 1; i <= ef.Extent(); ++i) {
    fs.clear();
    for (TopTools_ListIteratorOfListOfShape it(ef(i)); it.More(); it.Next()) {
      const int k = solidFaces.FindIndex(it.Value());
      if (k > 0 && std::find(fs.begin(), fs.end(), k) == fs.end()) fs.push_back(k);
    }
    bool touchesPick = false;
    for (int k : fs) {
      e[k] += 1.;
      if (picked[k]) touchesPick = true;
    }
    if (touchesPick)
      for (int k : fs)
        if (!picked[k]) lost[k] += 1.;
    for (size_t a = 0; a < fs.size(); ++a)
      for (size_t b = a + 1; b < fs.size(); ++b) pairs.emplace_back(std::min(fs[a], fs[b]), std::max(fs[a], fs[b]));
  }
  std::sort(pairs.begin(), pairs.end());
  pairs.erase(std::unique(pairs.begin(), pairs.end()), pairs.end());
  std::vector<std::vector<int>> next(n + 1);
  for (const auto& p : pairs) {
    const double a = e[p.first], b = e[p.second];
    c.pairWork += a * b + a + b;
    if (!picked[p.first] && !picked[p.second]) {
      const double a2 = a - lost[p.first], b2 = b - lost[p.second];
      c.pairWorkAfter += a2 * b2 + a2 + b2;
    }
    next[p.first].push_back(p.second);
    next[p.second].push_back(p.first);
  }
  std::vector<char> isFree(n + 1, 0);
  for (int k = 1; k <= n; ++k) {
    isFree[k] = freeForm(TopoDS::Face(solidFaces(k))) ? 1 : 0;
    if (isFree[k] && picked[k]) ++c.freePicks;
  }
  for (const std::vector<int>& ch : chains) {
    bool free = false;
    for (int k : ch) {
      if (isFree[k]) free = true;
      for (int g : next[k])
        if (isFree[g]) free = true;
      if (free) break;
    }
    if (free) ++c.freeChains;
  }
  return c;
}

// SuppressBlendsInc's run time in Node, predicted from counts before it runs (a running wasm call
// cannot be stopped: one past the watchdog kills the worker and rebuilds the whole Part). For every
// chain it takes off it re-recognises the fillets and builds a new adjacency graph of the body
// (chains x faces, and chains x the graph's pair work, averaged between the body before and after:
// (w0 + w1 + sqrt(w0 w1)) / 3); each chain's faces are killed and their edges rebuilt against the
// whole body (picks x faces); chains among free-form faces cost more. Refitted (least squares on the
// relative error) on 175 rows measured on the kernel with the adjacency-graph speed hunk
// (asi-occt79-wasm.patch), Node 24, 2026-11-02: combs with 5-100 teeth rounded on their lateral
// edges (24-404 one-face chains) or every edge (one chain of 120-1,220 faces), plates with 100-5,000
// holes and 4 or 1 chains, 3x3-11x11 pegs (36-484 chains) and 2x2-6x6 pegs rounded on every edge,
// their B-spline copies, the Step 0 family and part A, 10 NIST parts at 5 radii each, pin-fin and
// plate-fin heat sinks, a perforated plate with rounded holes, gears, an L bracket, and the rounded
// L-block with a 1,000-5,000-sided prism on it. The speed hunk cut the pair-work term to 0.43x
// (1.7893e-5 before); the others moved under 10 %. The model reads within 0.7-1.5x on most built parts; it
// reads 2.3-2.9x low on the rings of fillets round the pins of a pin-fin heat sink (its roots alone)
// and up to 3.6x low on two NIST parts (CTC-02, CTC-05), hence the budget: kernel-build/SOURCES.md,
// "suppress_blends' budget".
const double kMsPerChainPairWork = 7.6630e-6;
const double kMsPerChainFace = 2.6603e-2;
const double kMsPerPickFace = 2.4951e-3;
const double kMsPerFreeFormChain = 14.835;
const double kMsPerFreeFormPick = 1.3371;
// The longest predicted run started: the slowest accepted measured runs then took 3.0 s and 2.1 s
// (3.1 s and 2.2 s for the whole op; the roots of 5 x 6 and 5 x 5 pin-fin heat sinks, which the
// model reads 2.7-2.8x low) and 2.0 s (a NIST part), every other accepted run under 1.6 s; refused
// runs measured 1.4 s to 37 s.
const double kSuppressBudgetMs = 1400.;

double predictSuppressMs(int faces, int picks, int chains, const CostCounts& c) {
  const double w = (c.pairWork + c.pairWorkAfter + std::sqrt(c.pairWork * c.pairWorkAfter)) / 3.;
  return kMsPerChainPairWork * chains * w + kMsPerChainFace * chains * faces + kMsPerPickFace * picks * faces +
         kMsPerFreeFormChain * c.freeChains + kMsPerFreeFormPick * c.freePicks;
}

// ------------------------------------------------------------------- history ---

typedef asiAlgo_History::t_item Item;
typedef std::unordered_map<const TopoDS_TShape*, int> TIndex;

TIndex tindex(const TopTools_IndexedMapOfShape& m) {
  TIndex t;
  for (int i = 1; i <= m.Extent(); ++i) t.emplace(m(i).TShape().get(), i);
  return t;
}

// Where one input sub-shape went: the result sub-shapes its Modified chains end in (all leaves,
// not ConvertToOcc's first image), those reached through Generated, and how many leaves were
// deleted or are live but not in the result (stale: Concatenate keeps a leaf whose next chain
// deleted it directly as a live leaf with no image).
struct Fate {
  std::vector<int> images, generated;
  int deleted = 0, stale = 0;
};

void walkGen(const Item* p, TopAbs_ShapeEnum type, const TIndex& res, Fate& f, std::set<const Item*>& seen);

void walkMod(const Item* p, TopAbs_ShapeEnum type, const TIndex& res, Fate& f, std::set<const Item*>& seen) {
  if (!p || !seen.insert(p).second) return;
  for (const Item* g : p->Generated) walkGen(g, type, res, f, seen);
  if (p->IsDeleted) {
    ++f.deleted;
    return;
  }
  if (!p->Modified.empty()) {
    for (const Item* c : p->Modified) walkMod(c, type, res, f, seen);
    return;
  }
  const TopoDS_Shape& s = p->TransientPtr;
  auto it = s.IsNull() || s.ShapeType() != type ? res.end() : res.find(s.TShape().get());
  if (it == res.end()) ++f.stale;
  else if (std::find(f.images.begin(), f.images.end(), it->second) == f.images.end()) f.images.push_back(it->second);
}

void walkGen(const Item* p, TopAbs_ShapeEnum type, const TIndex& res, Fate& f, std::set<const Item*>& seen) {
  if (!p || !seen.insert(p).second) return;
  for (const Item* g : p->Generated) walkGen(g, type, res, f, seen);
  if (p->IsDeleted) return;
  if (!p->Modified.empty()) {
    for (const Item* c : p->Modified) walkGen(c, type, res, f, seen);
    return;
  }
  const TopoDS_Shape& s = p->TransientPtr;
  if (s.IsNull() || s.ShapeType() != type) return;
  auto it = res.find(s.TShape().get());
  if (it != res.end() && std::find(f.generated.begin(), f.generated.end(), it->second) == f.generated.end())
    f.generated.push_back(it->second);
}

// The fate of every sub-shape of `in` of one type, from the merged history.
std::vector<Fate> fates(const Handle(asiAlgo_History)& h, const TopTools_IndexedMapOfShape& in,
                        const TopTools_IndexedMapOfShape& res, TopAbs_ShapeEnum type, int& dropped) {
  const TIndex rt = tindex(res);
  const asiAlgo_History::t_shapeItemMap& nodes = h->GetNodes();
  std::vector<Fate> out(in.Extent() + 1);
  dropped = 0;
  for (int i = 1; i <= in.Extent(); ++i) {
    const TopoDS_Shape& s = in(i);
    Fate& f = out[i];
    if (nodes.Contains(s)) {
      std::set<const Item*> seen;
      walkMod(nodes.FindFromKey(s), type, rt, f, seen);
    } else if (rt.count(s.TShape().get())) {
      f.images.push_back(rt.at(s.TShape().get()));  // untouched: the same sub-shape
    } else {
      ++dropped;  // no record and not in the result: deleted directly by the first chain
    }
    std::sort(f.images.begin(), f.images.end());
    std::sort(f.generated.begin(), f.generated.end());
  }
  return out;
}

// The fates as a BRepTools_History (what facade.cpp's historyForPairs reads): a sub-shape whose
// only image is itself gets no record ("same"), one with images is modified into all of them,
// one with none is removed.
void record(BRepTools_History& oh, const TopTools_IndexedMapOfShape& in, const TopTools_IndexedMapOfShape& res,
            const std::vector<Fate>& fs) {
  for (int i = 1; i <= in.Extent(); ++i) {
    const TopoDS_Shape& s = in(i);
    const Fate& f = fs[i];
    const bool same = f.images.size() == 1 && res(f.images[0]).IsSame(s);
    if (f.images.empty()) oh.Remove(s);
    else if (!same)
      for (int k : f.images) oh.AddModified(s, res(k));
    for (int k : f.generated)
      if (!res(k).IsSame(s)) oh.AddGenerated(s, res(k));
  }
}

}  // namespace

const char* version() { return "2026.1.1"; }

double suppressBudgetMs() { return kSuppressBudgetMs; }

std::string budgetWords(long long picks, long long faces, double predictedMs, double budgetMs) {
  return "taking " + commas(picks) + " fillet face" + (picks == 1 ? "" : "s") + " off as fillets on a body of " +
         commas(faces) + " faces would take " + aboutTime(predictedMs, budgetMs) + "; Delete faces allows " +
         secondsText(budgetMs) + " for taking fillets off as fillets";
}

Refusal recognize(const TopoDS_Shape& body, const TopTools_IndexedMapOfShape& faces, const RecognizeOptions& opts,
                  Recognition& out) {
  out = Recognition();
  out.faces = faces.Extent();
  TopTools_IndexedMapOfShape solids;
  TopExp::MapShapes(body, TopAbs_SOLID, solids);
  out.solids = solids.Extent();
  if (out.solids == 0) return refuse("input", "no solid in this body (fillets and holes are found on solids only)");
  const double diag = diagonalOf(body);
  std::vector<Chain> chains;
  for (int s = 1; s <= solids.Extent(); ++s) {
    if (opts.blends) {
      const double radius = opts.maxR > 0 ? opts.maxR : diag;
      Refusal r = guarded("fillet recognition", [&] { return blendsOf(solids(s), faces, radius, out, chains); });
      if (!r.ok()) return r;
    }
    if (opts.holes) {
      Refusal r = guarded("hole recognition", [&] { return holesOf(solids(s), faces, opts.hardHoles, diag, out); });
      if (!r.ok()) return r;
    }
  }
  // Pointer-hashed maps inside Analysis Situs follow heap layout: the answer is sorted so that
  // it never depends on it.
  std::sort(out.blends.begin(), out.blends.end(), [](const Blend& a, const Blend& b) { return a.face < b.face; });
  std::sort(chains.begin(), chains.end(), [](const Chain& a, const Chain& b) {
    return a.faces.front() != b.faces.front() ? a.faces.front() < b.faces.front() : a.faces < b.faces;
  });
  std::map<int, size_t> blendAt;
  for (size_t i = 0; i < out.blends.size(); ++i) blendAt[out.blends[i].face] = i;
  for (size_t c = 0; c < chains.size(); ++c) {
    Chain& ch = chains[c];
    bool any = false;
    for (int f : ch.faces) {
      auto it = blendAt.find(f);
      if (it == blendAt.end()) continue;
      Blend& b = out.blends[it->second];
      if (b.chain < 0) b.chain = (int)c;  // a vertex blend in two chains takes the first
      if (!any || b.r_min < ch.r_min) ch.r_min = b.r_min;
      if (!any || b.r_max > ch.r_max) ch.r_max = b.r_max;
      any = true;
    }
  }
  out.chains = chains;
  std::sort(out.holes.begin(), out.holes.end(), [](const Hole& a, const Hole& b) { return a.faces < b.faces; });
  return done();
}

Refusal suppressBlends(const TopoDS_Shape& body, const TopTools_IndexedMapOfShape& faces, const std::vector<int>& picksIn,
                       bool useConvertToOcc, double budgetMs, Suppression& out) {
  out = Suppression();
  std::vector<int> picks(picksIn);
  std::sort(picks.begin(), picks.end());
  picks.erase(std::unique(picks.begin(), picks.end()), picks.end());
  if (picks.empty()) return refuse("input", "no faces given");
  for (int p : picks)
    if (p < 0 || p >= faces.Extent()) return refuse("input", "face index " + std::to_string(p) + " out of range");
  out.asked = (int)picks.size();

  // 1. One solid, and nothing beside it.
  TopTools_IndexedMapOfShape solids;
  TopExp::MapShapes(body, TopAbs_SOLID, solids);
  if (solids.Extent() == 0) return refuse("input", "no solid in this body (fillets are taken off solids only)");
  if (solids.Extent() > 1)
    return refuse("input", "this body has " + std::to_string(solids.Extent()) + " solids: fillets are taken off one solid at a time");
  const TopoDS_Shape solid = solids(1);
  TopTools_IndexedMapOfShape solidFaces, solidEdges;
  TopExp::MapShapes(solid, TopAbs_FACE, solidFaces);
  TopExp::MapShapes(solid, TopAbs_EDGE, solidEdges);
  if (solidFaces.Extent() != faces.Extent()) return refuse("input", "this body has faces outside its solid: fillets are taken off solids only");

  // 2. Every pick is a fillet, as `recognize` finds them.
  double t0 = nowMs();
  Recognition rec;
  RecognizeOptions ro;
  ro.holes = false;
  Refusal r = recognize(body, faces, ro, rec);
  if (!r.ok()) return r;
  std::map<int, const Blend*> blendOf;
  for (const Blend& b : rec.blends) blendOf[b.face] = &b;
  int notFillets = 0;
  for (int p : picks) {
    auto it = blendOf.find(p);
    if (it == blendOf.end() || it->second->kind == "uncertain") ++notFillets;
    else out.r = std::max(out.r, it->second->r_max);
  }
  if (notFillets > 0) {
    if (notFillets == (int)picks.size())
      return refuse("input", picks.size() == 1 ? "the face is not a fillet" : "none of the " + std::to_string(picks.size()) + " faces are fillets");
    return refuse("input", std::to_string(notFillets) + " of the " + std::to_string(picks.size()) + " faces are not fillets");
  }
  if (!(out.r > 0)) return refuse("input", "the fillets' radius could not be measured");
  out.max_r = out.r * (1. + 1e-3);

  // 3. The pick is every fillet up to R, as SuppressBlendsInc itself will recognise them
  //    (a fresh AAG, RecognizeBlends(R)): it takes off all of them or refuses here.
  std::vector<int> atR;
  std::vector<std::vector<int>> chainsAtR;  // body face indices
  r = guarded("fillet recognition", [&] {
    Handle(asiAlgo_AAG) aag = new asiAlgo_AAG(solid, false);
    std::vector<int> toBody;
    Refusal e;
    if (!mapIds(aag, faces, toBody, e)) return e;
    asiAlgo_RecognizeBlends rb(aag);
    if (!rb.Perform(out.max_r)) return refuse("occt", "fillet recognition failed");
    atR = sortedIds(rb.GetResultIndices(), toBody);
    std::vector<asiAlgo_BlendChain> raw;
    rb.GetChains(raw);
    for (const asiAlgo_BlendChain& c : raw) {
      std::vector<int> ch = sortedIds(c.first, toBody);
      if (!ch.empty()) chainsAtR.push_back(std::move(ch));
    }
    return done();
  });
  if (!r.ok()) return r;
  out.recognize_ms = nowMs() - t0;
  if (atR != picks) {
    std::vector<int> missing;
    std::set_difference(picks.begin(), picks.end(), atR.begin(), atR.end(), std::back_inserter(missing));
    const std::string head = "the fillets up to R" + num(out.r) + " are " + std::to_string(atR.size()) + " face" + (atR.size() == 1 ? "" : "s");
    if (missing.empty()) return refuse("input", head + "; " + std::to_string(picks.size()) + " are picked");
    return refuse("input", head + ", not the " + std::to_string(picks.size()) + " picked (" + std::to_string(missing.size()) +
                               " of them read as larger fillets)");
  }

  // 4. The run-time budget: a running wasm call cannot be stopped, and one past the watchdog
  //    kills the worker and rebuilds the whole Part, so a run predicted to take too long is
  //    refused in words before it starts.
  std::vector<bool> pickedSolid(solidFaces.Extent() + 1, false);
  for (int p : picks) pickedSolid[solidFaces.FindIndex(faces(p + 1))] = true;
  for (std::vector<int>& ch : chainsAtR)
    for (int& f : ch) f = solidFaces.FindIndex(faces(f + 1));
  const CostCounts cc = costCounts(solid, solidFaces, pickedSolid, chainsAtR);
  out.cost_chains = (int)chainsAtR.size();
  out.cost_pair_work = cc.pairWork;
  out.cost_pair_work_after = cc.pairWorkAfter;
  out.cost_free_chains = cc.freeChains;
  out.cost_free_picks = cc.freePicks;
  out.predicted_ms = predictSuppressMs(solidFaces.Extent(), (int)picks.size(), out.cost_chains, cc);
  out.budget_ms = budgetMs > 0 ? std::min(budgetMs, kSuppressBudgetMs) : kSuppressBudgetMs;
#ifndef MK_TEST_NO_SUPPRESS_BUDGET
  if (out.predicted_ms > out.budget_ms)
    return refuse("input", budgetWords((long long)picks.size(), solidFaces.Extent(), out.predicted_ms, out.budget_ms));
#endif

  // 5. SuppressBlendsInc on a fresh AAG.
  Handle(asiAlgo_History) hist;
  TopoDS_Shape res;
  int n = 0;
  bool ok = false;
  t0 = nowMs();
  r = guarded("taking the fillets off", [&] {
    Handle(asiAlgo_AAG) aag = new asiAlgo_AAG(solid, false);
    asiAlgo_SuppressBlendsInc inc;
    ok = inc.Perform(aag, out.max_r, true, res, hist, n);
    return done();
  });
  out.suppress_ms = nowMs() - t0;
  if (!r.ok()) return r;
  if (!ok) return refuse("occt", "the faces next to the fillets could not be rebuilt");
  if (n == 0 || res.IsNull() || res.IsSame(solid) || hist.IsNull()) {
    std::vector<int> all;
    for (int p : picks) all.push_back(solidFaces.FindIndex(faces(p + 1)));
    return refuse("input", "no fillet could be taken off " + whyLeft(solidFaces, all));
  }
  out.chains = n;

  // 6. History: every input face and edge walked to all its leaves.
  t0 = nowMs();
  TopTools_IndexedMapOfShape resFaces, resEdges;
  TopExp::MapShapes(res, TopAbs_FACE, resFaces);
  TopExp::MapShapes(res, TopAbs_EDGE, resEdges);
  int droppedEdges = 0;
  const std::vector<Fate> ff = fates(hist, solidFaces, resFaces, TopAbs_FACE, out.dropped);
  const std::vector<Fate> fe = fates(hist, solidEdges, resEdges, TopAbs_EDGE, droppedEdges);

  // 7. The self-check: an input face is gone exactly when it was picked, and every result face
  //    is an input face or has a source.
  std::set<int> picked;
  for (int p : picks) picked.insert(solidFaces.FindIndex(faces(p + 1)));
  int taken = 0;
  std::vector<bool> sourced(resFaces.Extent() + 1, false);
  std::vector<int> leftFaces;
  for (int i = 1; i <= solidFaces.Extent(); ++i) {
    const Fate& f = ff[i];
    out.stale += f.stale;
    const bool gone = f.images.empty();
    if (picked.count(i)) {
      if (gone) ++out.removed;
      else {
        ++out.left;
        leftFaces.push_back(i);
      }
    } else {
      if (gone) ++taken;
      if (f.images.size() > 1) ++out.split;
    }
    for (int k : f.images) sourced[k] = true;
    for (int k : f.generated) sourced[k] = true;
  }
  int noSource = 0;
  for (int k = 1; k <= resFaces.Extent(); ++k)
    if (!sourced[k]) ++noSource;
  if (out.left > 0)
    return refuse("input", std::to_string(out.left) + " of the " + std::to_string(picks.size()) +
                               " fillet faces could not be taken off " + whyLeft(solidFaces, leftFaces));
  if (taken > 0) return refuse("input", "faces that were not picked were taken off");
  if (noSource > 0) return refuse("input", "the result had faces with no source");

  Handle(BRepTools_History) oh = new BRepTools_History;
  record(*oh, solidFaces, resFaces, ff);
  record(*oh, solidEdges, resEdges, fe);

  // Analysis Situs' ConvertToOcc (each root's first image only) read the facade's way, against
  // the all-leaves history: recorded for comparison, reported instead when asked (tests only).
  Handle(BRepTools_History) occ = hist->ConvertToOcc();
  if (!occ.IsNull()) {
    std::vector<bool> occSourced(resFaces.Extent() + 1, false);
    for (int i = 1; i <= solidFaces.Extent(); ++i) {
      const TopoDS_Shape& F = solidFaces(i);
      int imgs = 0;
      for (TopTools_ListIteratorOfListOfShape it(occ->Modified(F)); it.More(); it.Next()) {
        const int k = resFaces.FindIndex(it.Value());
        if (k) {
          occSourced[k] = true;
          ++imgs;
        }
      }
      if (!imgs && !occ->IsRemoved(F)) {
        const int k = resFaces.FindIndex(F);
        if (k) {
          occSourced[k] = true;
          ++imgs;
        }
      }
      if ((imgs > 0) != !ff[i].images.empty()) ++out.occ_disagree;
      if (imgs < (int)ff[i].images.size()) ++out.occ_fewer_images;
    }
    for (int k = 1; k <= resFaces.Extent(); ++k)
      if (!occSourced[k]) ++out.occ_no_source;
  }
  out.history_ms = nowMs() - t0;
  if (useConvertToOcc) {
    if (occ.IsNull()) return refuse("internal", "internal: ConvertToOcc returned no history");
    out.history = occ;
  } else {
    out.history = oh;
  }
  out.shape = res;
  return done();
}

}  // namespace mkasi
