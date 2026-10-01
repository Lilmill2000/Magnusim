// Magnusim CAD kernel facade over OCCT 7.9.3, compiled to WebAssembly.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// JavaScript never holds OCCT objects. It calls mk_call(json) and gets JSON
// back; shapes are integer ids into a C++ map. Faces, edges and vertices are
// indexed with TopExp::MapShapes and reported starting at 0.
//
// Rules every op follows (src/types/kernel-protocol.ts is the typed contract):
// - An op that makes a shape reports `valid` (BRepCheck) and, when false, why
//   (addValidity). An invalid result is returned as ok:true, valid:false, never
//   as a plain success; OCCT refusing outright is ok:false.
// - An op that could change a stored shape runs on work copies of its inputs
//   (WorkCopies), so a failure never corrupts a body the caller still holds.
// - Anything slow on a large part is opt-in (props volume/area/exact bbox, topo
//   per requested sub-shape).

#include "mkjson.hpp"

#include <emscripten.h>
#include <emscripten/heap.h>
#include <malloc.h>
#include <unistd.h>
#include <errno.h>

#include <algorithm>
#include <istream>
#include <map>
#include <memory>
#include <new>
#include <set>
#include <sstream>
#include <streambuf>
#include <unordered_map>

#include <Standard_Version.hxx>
#include <Standard_Failure.hxx>
#include <Standard_OutOfMemory.hxx>
#include <Standard.hxx>
#include <Message.hxx>
#include <Message_Messenger.hxx>
#include <Message_PrinterOStream.hxx>

#include <TopoDS.hxx>
#include <TopoDS_Shape.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Vertex.hxx>
#include <TopoDS_Wire.hxx>
#include <TopoDS_Compound.hxx>
#include <TopoDS_Iterator.hxx>
#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopTools_ListOfShape.hxx>
#include <BRepTools_History.hxx>
#include <BRepCheck.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepCheck_ListOfStatus.hxx>
#include <BRepCheck_Result.hxx>
#include <BOPAlgo_GlueEnum.hxx>
#include <Geom2d_Curve.hxx>
#include <Geom_Surface.hxx>
#include <gp_Cylinder.hxx>
#include <gp_Cone.hxx>
#include <gp_Sphere.hxx>
#include <gp_Torus.hxx>
#include <Precision.hxx>
#include <BRepPrimAPI_MakeHalfSpace.hxx>
#include <ShapeBuild_ReShape.hxx>
#include <ShapeExtend_Status.hxx>

#include <gp_Ax1.hxx>
#include <gp_Ax2.hxx>
#include <gp_Ax3.hxx>
#include <gp_Pln.hxx>
#include <gp_Lin.hxx>
#include <gp_Circ.hxx>
#include <gp_Pnt2d.hxx>
#include <gp_Vec.hxx>
#include <gp_Trsf.hxx>

#include <BRepBuilderAPI_Copy.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakeVertex.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakeCylinder.hxx>
#include <BRepPrimAPI_MakePrism.hxx>
#include <BRepPrimAPI_MakeRevol.hxx>
#include <BRepPrimAPI_MakeSphere.hxx>
#include <LocOpe_DPrism.hxx>

#include <BRepAlgoAPI_Common.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepAlgoAPI_Defeaturing.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepAlgoAPI_Splitter.hxx>
#include <ShapeUpgrade_UnifySameDomain.hxx>
#include <BRepFilletAPI_MakeChamfer.hxx>
#include <BRepFilletAPI_MakeFillet.hxx>
#include <BRepOffsetAPI_MakeThickSolid.hxx>

#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepBndLib.hxx>
#include <BRepExtrema_DistShapeShape.hxx>
#include <BRepGProp.hxx>
#include <Bnd_Box.hxx>
#include <GCPnts_AbscissaPoint.hxx>
#include <GCPnts_TangentialDeflection.hxx>
#include <GProp_GProps.hxx>

#include <BRepLib_ToolTriangulatedShape.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <Poly_Polygon3D.hxx>
#include <Poly_PolygonOnTriangulation.hxx>
#include <Poly_Triangulation.hxx>

#include <ShapeFix_Shape.hxx>

#include <DESTEP_Parameters.hxx>
#include <IFSelect_ReturnStatus.hxx>
#include <Interface_Static.hxx>
#include <STEPCAFControl_Reader.hxx>
#include <STEPCAFControl_Writer.hxx>
#include <STEPControl_Reader.hxx>
#include <Quantity_Color.hxx>
#include <TCollection_AsciiString.hxx>
#include <TCollection_ExtendedString.hxx>
#include <TDF_Label.hxx>
#include <TDF_LabelSequence.hxx>
#include <TDataStd_Name.hxx>
#include <TDocStd_Document.hxx>
#include <XCAFApp_Application.hxx>
#include <XCAFDoc_ColorTool.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <XCAFDoc_ShapeTool.hxx>

// ------------------------------------------------ allocation-failure count ---
// dlmalloc's malloc family is weak; these wrappers count failed allocations so an
// op that ran out of memory is reported as such even when OCCT catches the
// exception internally (BOPAlgo turns it into "builder failed", BRepMesh into a
// partial mesh).
//
// A reserve block is freed on the first failure, so that throwing the resulting
// exception (__cxa_allocate_exception needs heap) and unwinding can still allocate;
// without it a full heap ended in std::terminate -> abort (measured on wasm32).
static size_t g_allocFail = 0;
static void* g_reserve = nullptr;
static const size_t kReserveBytes = (size_t)4 << 20;
static inline void onAllocFail() {
  ++g_allocFail;
  if (g_reserve) {
    emscripten_builtin_free(g_reserve);
    g_reserve = nullptr;
  }
}
static bool restoreReserve() {
  if (!g_reserve) g_reserve = emscripten_builtin_malloc(kReserveBytes);
  return g_reserve != nullptr;
}
extern "C" {
void* malloc(size_t n) {
  void* p = emscripten_builtin_malloc(n);
  if (!p && n) onAllocFail();
  return p;
}
void* calloc(size_t a, size_t b) {
  void* p = emscripten_builtin_calloc(a, b);
  if (!p && a && b) onAllocFail();
  return p;
}
void* realloc(void* q, size_t n) {
  void* p = emscripten_builtin_realloc(q, n);
  if (!p && n) onAllocFail();
  return p;
}
void* memalign(size_t a, size_t n) {
  void* p = emscripten_builtin_memalign(a, n);
  if (!p && n) onAllocFail();
  return p;
}
int posix_memalign(void** out, size_t a, size_t n) {
  void* p = emscripten_builtin_memalign(a, n);
  if (!p && n) {
    onAllocFail();
    return ENOMEM;
  }
  *out = p;
  return 0;
}
}

using mk::InputError;
using mk::JV;
using mk::vec3;

namespace {

// ---------------------------------------------------------------- errors ---

struct OcctError : std::runtime_error {
  explicit OcctError(const std::string& m) : std::runtime_error(m) {}
};

double nowMs() { return emscripten_get_now(); }

// ----------------------------------------------------------- shape store ---

struct Indexed {
  TopTools_IndexedMapOfShape f, e, v;
  TopTools_IndexedDataMapOfShapeListOfShape edgeFaces;
  bool haveEdgeFaces = false;
};

struct Entry {
  TopoDS_Shape shape;
  std::unique_ptr<Indexed> idx;
};

std::unordered_map<int, Entry> g_store;
int g_next = 1;

int putShape(const TopoDS_Shape& s) {
  int id = g_next++;
  g_store[id].shape = s;
  return id;
}

Entry& entryOf(int id) {
  auto it = g_store.find(id);
  if (it == g_store.end()) throw InputError("unknown shape id " + std::to_string(id));
  return it->second;
}

const TopoDS_Shape& shapeOf(int id) { return entryOf(id).shape; }

Indexed& indexOf(int id) {
  Entry& en = entryOf(id);
  if (!en.idx) {
    en.idx.reset(new Indexed());
    TopExp::MapShapes(en.shape, TopAbs_FACE, en.idx->f);
    TopExp::MapShapes(en.shape, TopAbs_EDGE, en.idx->e);
    TopExp::MapShapes(en.shape, TopAbs_VERTEX, en.idx->v);
  }
  return *en.idx;
}

const TopTools_IndexedDataMapOfShapeListOfShape& edgeFacesOf(int id) {
  Indexed& ix = indexOf(id);
  if (!ix.haveEdgeFaces) {
    TopExp::MapShapesAndAncestors(entryOf(id).shape, TopAbs_EDGE, TopAbs_FACE, ix.edgeFaces);
    ix.haveEdgeFaces = true;
  }
  return ix.edgeFaces;
}

int idParam(const JV& v, const char* what) {
  if (!v.isNum()) throw InputError(std::string(what) + " must be a shape id");
  return (int)v.num();
}

TopoDS_Face faceAt(int id, const JV& v) {
  Indexed& ix = indexOf(id);
  int i = (int)v.num();
  if (i < 0 || i >= ix.f.Extent()) throw InputError("face index " + std::to_string(i) + " out of range");
  return TopoDS::Face(ix.f(i + 1));
}

TopoDS_Edge edgeAt(int id, const JV& v) {
  Indexed& ix = indexOf(id);
  int i = (int)v.num();
  if (i < 0 || i >= ix.e.Extent()) throw InputError("edge index " + std::to_string(i) + " out of range");
  return TopoDS::Edge(ix.e(i + 1));
}

// Collapse a compound with one child into that child.
TopoDS_Shape unwrap(const TopoDS_Shape& s) {
  TopoDS_Shape cur = s;
  while (!cur.IsNull() && cur.ShapeType() == TopAbs_COMPOUND) {
    TopoDS_Iterator it(cur);
    if (!it.More()) break;
    TopoDS_Shape first = it.Value();
    it.Next();
    if (it.More()) break;
    cur = first;
  }
  return cur;
}

// --------------------------------------------------------------- helpers ---

gp_Pnt pnt(const JV& a) {
  if (!a.isArr() || a.size() != 3) throw InputError("expected [x,y,z]");
  return gp_Pnt(a[0].num(), a[1].num(), a[2].num());
}

gp_Dir dir(const JV& a) {
  if (!a.isArr() || a.size() != 3) throw InputError("expected [x,y,z] direction");
  gp_Vec v(a[0].num(), a[1].num(), a[2].num());
  if (v.Magnitude() < 1e-12) throw InputError("zero-length direction");
  return gp_Dir(v);
}

gp_Pnt pntOr(const JV& q, const char* key, const gp_Pnt& def) {
  return q.has(key) ? pnt(q.req(key)) : def;
}

JV p3(const gp_Pnt& p) { return vec3(p.X(), p.Y(), p.Z()); }
JV d3(const gp_Dir& d) { return vec3(d.X(), d.Y(), d.Z()); }

JV bboxJson(const TopoDS_Shape& s, const std::string& mode) {
  Bnd_Box b;
  if (mode == "fast") BRepBndLib::Add(s, b, false);
  else if (mode == "optimal_tol") BRepBndLib::AddOptimal(s, b, false, true);
  else BRepBndLib::AddOptimal(s, b, false, false);
  if (b.IsVoid()) return JV();
  double x0, y0, z0, x1, y1, z1;
  b.Get(x0, y0, z0, x1, y1, z1);
  JV a = JV::arr();
  for (double d : {x0, y0, z0, x1, y1, z1}) a.push(d);
  return a;
}

int countOf(const TopoDS_Shape& s, TopAbs_ShapeEnum t) {
  TopTools_IndexedMapOfShape m;
  TopExp::MapShapes(s, t, m);
  return m.Extent();
}

std::string failureText(const Standard_Failure& e) {
  std::string t = e.DynamicType()->Name();
  const char* m = e.GetMessageString();
  if (m && *m) t += std::string(": ") + m;
  return t;
}

// A malloc'd growable buffer whose ownership passes to JS.
template <class T>
struct MBuf {
  T* p = nullptr;
  size_t n = 0, cap = 0;
  ~MBuf() { free(p); }
  void reserve(size_t c) {
    if (c <= cap) return;
    size_t nc = std::max(c, cap ? cap * 2 : (size_t)1024);
    T* np = (T*)realloc(p, nc * sizeof(T));
    if (!np) throw std::bad_alloc();
    p = np;
    cap = nc;
  }
  void push(T v) {
    if (n == cap) reserve(n + 1);
    p[n++] = v;
  }
  JV release(const char* name, const char* type) {
    if (!p) reserve(1);
    JV b = JV::obj();
    b.set("name", name);
    b.set("ptr", (double)(uintptr_t)p);
    b.set("len", (double)(n * sizeof(T)));
    b.set("type", type);
    p = nullptr;
    n = cap = 0;
    return b;
  }
};

// --------------------------------------------------------------- history ---

struct HistBuilder {
  // out index -> from entries
  std::map<int, JV> faceFrom, edgeFrom;
  JV deleted = JV::arr();

  static JV from(int shape, const char* key, int i, const char* how) {
    JV o = JV::obj();
    o.set("shape", shape);
    o.set(key, i);
    o.set("how", how);
    return o;
  }

  void add(std::map<int, JV>& m, int out, JV f) {
    JV& slot = m[out];
    if (slot.isNull()) slot = JV::arr();
    slot.push(std::move(f));
  }

  // Record where each sub-shape of the input went in `out`.
  void addInput(int inId, BRepTools_History& h, const Indexed& out, int reportAs = 0) {
    Indexed& in = indexOf(inId);
    const int rid = reportAs ? reportAs : inId;
    auto routeGenerated = [&](const TopoDS_Shape& src, const char* key, int i) {
      const TopTools_ListOfShape& gens = h.Generated(src);
      for (TopTools_ListIteratorOfListOfShape it(gens); it.More(); it.Next()) {
        const TopoDS_Shape& g = it.Value();
        if (g.ShapeType() == TopAbs_FACE) {
          int k = out.f.FindIndex(g);
          if (k) add(faceFrom, k - 1, from(rid, key, i, "generated"));
        } else if (g.ShapeType() == TopAbs_EDGE) {
          int k = out.e.FindIndex(g);
          if (k) add(edgeFrom, k - 1, from(rid, key, i, "generated"));
        }
      }
    };
    for (int i = 1; i <= in.f.Extent(); ++i) {
      const TopoDS_Shape& F = in.f(i);
      const TopTools_ListOfShape& mods = h.Modified(F);
      bool landed = false;
      for (TopTools_ListIteratorOfListOfShape it(mods); it.More(); it.Next()) {
        if (it.Value().ShapeType() != TopAbs_FACE) continue;
        int k = out.f.FindIndex(it.Value());
        if (k) {
          add(faceFrom, k - 1, from(rid, "face", i - 1, "modified"));
          landed = true;
        }
      }
      if (!landed && !h.IsRemoved(F)) {
        int k = out.f.FindIndex(F);
        if (k) {
          add(faceFrom, k - 1, from(rid, "face", i - 1, "same"));
          landed = true;
        }
      }
      if (!landed) {
        JV d = JV::obj();
        d.set("shape", rid);
        d.set("face", i - 1);
        deleted.push(std::move(d));
      }
      routeGenerated(F, "face", i - 1);
    }
    for (int i = 1; i <= in.e.Extent(); ++i) {
      const TopoDS_Shape& E = in.e(i);
      const TopTools_ListOfShape& mods = h.Modified(E);
      bool landed = false;
      for (TopTools_ListIteratorOfListOfShape it(mods); it.More(); it.Next()) {
        if (it.Value().ShapeType() != TopAbs_EDGE) continue;
        int k = out.e.FindIndex(it.Value());
        if (k) {
          add(edgeFrom, k - 1, from(rid, "edge", i - 1, "modified"));
          landed = true;
        }
      }
      if (!landed && !h.IsRemoved(E)) {
        int k = out.e.FindIndex(E);
        if (k) {
          add(edgeFrom, k - 1, from(rid, "edge", i - 1, "same"));
          landed = true;
        }
      }
      if (!landed) {
        JV d = JV::obj();
        d.set("shape", rid);
        d.set("edge", i - 1);
        deleted.push(std::move(d));
      }
      routeGenerated(E, "edge", i - 1);
    }
    for (int i = 1; i <= in.v.Extent(); ++i) routeGenerated(in.v(i), "vertex", i - 1);
  }

  JV json() {
    JV h = JV::obj();
    JV faces = JV::arr(), edges = JV::arr();
    for (auto& kv : faceFrom) {
      JV o = JV::obj();
      o.set("out", kv.first);
      o.set("from", std::move(kv.second));
      faces.push(std::move(o));
    }
    for (auto& kv : edgeFrom) {
      JV o = JV::obj();
      o.set("out", kv.first);
      o.set("from", std::move(kv.second));
      edges.push(std::move(o));
    }
    h.set("faces", std::move(faces));
    h.set("edges", std::move(edges));
    h.set("deleted", std::move(deleted));
    return h;
  }
};

// History of an op whose inputs ran as work copies: each pair is (the id the op
// ran on, the id to report). Copies keep the topology, so indices carry over.
JV historyForPairs(const std::vector<std::pair<int, int>>& inputs, BRepTools_History& h, int outId) {
  HistBuilder hb;
  Indexed& out = indexOf(outId);
  for (auto& p : inputs) hb.addInput(p.first, h, out, p.second);
  return hb.json();
}

// ------------------------------------------------------------ work copies ---
// Every op that could change a stored shape runs on private deep copies of its
// inputs (decision 2026-09-30). OCCT's algorithms can change their input's shared
// geometry in place (tolerances, pcurves) even when they fail: in P0 a failed
// fillet left its body looking valid, and a later cut on it removed 0.10 mm3 instead
// of 42,353 mm3. BRepBuilderAPI_Copy keeps the topology, so a copy's face, edge
// and vertex indices are its source's, and history is reported against the source
// id. Several inputs are copied together (one compound), so sub-shapes they share
// stay shared in the copies. The copies live under temporary negative ids for the
// duration of the op. MK_TEST_NO_WORK_COPY (tests only) runs on the stored shapes
// themselves, to show that the regression test catches the hazard.
int g_tmpNext = -1;

struct WorkCopies {
  std::vector<int> src, tmp;
  double ms = 0;
  explicit WorkCopies(const std::vector<int>& sources) : src(sources) {
    const double t0 = nowMs();
    std::vector<TopoDS_Shape> copies;
#ifdef MK_TEST_NO_WORK_COPY
    for (int id : sources) copies.push_back(shapeOf(id));
#else
    if (sources.size() == 1) {
      BRepBuilderAPI_Copy cp(shapeOf(sources[0]), Standard_True, Standard_False);
      copies.push_back(cp.Shape());
    } else {
      BRep_Builder bb;
      TopoDS_Compound all;
      bb.MakeCompound(all);
      for (int id : sources) bb.Add(all, shapeOf(id));
      BRepBuilderAPI_Copy cp(all, Standard_True, Standard_False);
      for (int id : sources) copies.push_back(cp.ModifiedShape(shapeOf(id)));
    }
#endif
    try {
      for (size_t k = 0; k < sources.size(); ++k) {
        const int t = g_tmpNext--;
        g_store[t].shape = copies[k];
        tmp.push_back(t);
        Indexed& a = indexOf(sources[k]);
        Indexed& b = indexOf(t);
        if (a.f.Extent() != b.f.Extent() || a.e.Extent() != b.e.Extent() || a.v.Extent() != b.v.Extent())
          throw std::runtime_error("internal: a work copy's topology differs from its source");
      }
    } catch (...) {
      for (int t : tmp) g_store.erase(t);
      throw;
    }
    ms = nowMs() - t0;
  }
  WorkCopies(const WorkCopies&) = delete;
  WorkCopies& operator=(const WorkCopies&) = delete;
  ~WorkCopies() {
    for (int t : tmp) g_store.erase(t);
  }
  int id(size_t k) const { return tmp[k]; }
  const TopoDS_Shape& shape(size_t k) const { return shapeOf(tmp[k]); }
  std::vector<std::pair<int, int>> pairs() const {
    std::vector<std::pair<int, int>> p;
    for (size_t k = 0; k < src.size(); ++k) p.emplace_back(tmp[k], src[k]);
    return p;
  }
};

// --------------------------------------------------------------- validity ---
// Every op that makes a shape reports `valid` from BRepCheck_Analyzer on the stored
// result, and when it is false, why: the statuses, on which sub-shapes (indices in
// the result's own face/edge/vertex index space), and a one-line reason. An invalid
// result is still stored and returned (ok:true, valid:false) so the document can
// show a red feature and offer `repair`; it is never passed off as valid.
// {"check":false} skips the analysis (then the result has checked:false and no
// `valid`, and the caller must check it).

const char* typeName(TopAbs_ShapeEnum t) {
  switch (t) {
    case TopAbs_COMPOUND: return "compound";
    case TopAbs_COMPSOLID: return "compsolid";
    case TopAbs_SOLID: return "solid";
    case TopAbs_SHELL: return "shell";
    case TopAbs_FACE: return "face";
    case TopAbs_WIRE: return "wire";
    case TopAbs_EDGE: return "edge";
    case TopAbs_VERTEX: return "vertex";
    default: return "shape";
  }
}

std::string statusName(BRepCheck_Status st) {
  std::ostringstream os;
  BRepCheck::Print(st, os);
  std::string s = os.str();
  while (!s.empty() && (s.back() == '\n' || s.back() == ' ')) s.pop_back();
  if (s.rfind("BRepCheck_", 0) == 0) s = s.substr(10);
  return s;
}

struct Validity {
  bool valid = true;
  double ms = 0;
  int total = 0;
  JV problems = JV::arr();
  std::map<std::string, int> counts;
  std::string reason;
};

Validity analyse(const TopoDS_Shape& s, size_t maxProblems = 40) {
  Validity v;
  const double t0 = nowMs();
  if (s.IsNull()) {
    v.valid = false;
    v.total = 1;
    v.counts["NullShape"] = 1;
    v.reason = "the operation returned no shape";
    v.ms = nowMs() - t0;
    return v;
  }
  BRepCheck_Analyzer an(s);
  v.valid = an.IsValid();
  if (!v.valid) {
    static const TopAbs_ShapeEnum kTypes[] = {TopAbs_VERTEX, TopAbs_EDGE,  TopAbs_WIRE,      TopAbs_FACE,
                                              TopAbs_SHELL,  TopAbs_SOLID, TopAbs_COMPSOLID, TopAbs_COMPOUND};
    std::map<TopAbs_ShapeEnum, TopTools_IndexedMapOfShape> maps;
    for (TopAbs_ShapeEnum t : kTypes) TopExp::MapShapes(s, t, maps[t]);
    std::set<std::string> seen;
    for (TopAbs_ShapeEnum t : kTypes) {
      const TopTools_IndexedMapOfShape& m = maps[t];
      for (int i = 1; i <= m.Extent(); ++i) {
        Handle(BRepCheck_Result) r;
        try {
          r = an.Result(m(i));
        } catch (const Standard_Failure&) {
          continue;
        }
        if (r.IsNull()) continue;
        auto addList = [&](const BRepCheck_ListOfStatus& L, const TopoDS_Shape* ctx) {
          for (BRepCheck_ListOfStatus::Iterator it(L); it.More(); it.Next()) {
            if (it.Value() == BRepCheck_NoError) continue;
            const std::string name = statusName(it.Value());
            int ci = 0;
            TopAbs_ShapeEnum ct = TopAbs_SHAPE;
            if (ctx) {
              ct = ctx->ShapeType();
              auto mt = maps.find(ct);
              ci = mt != maps.end() ? mt->second.FindIndex(*ctx) : 0;
            }
            const std::string key = name + "|" + typeName(t) + "|" + std::to_string(i) + "|" + std::to_string((int)ct) + "|" + std::to_string(ci);
            if (!seen.insert(key).second) continue;
            ++v.counts[name];
            ++v.total;
            if (v.problems.size() >= maxProblems) continue;
            JV p = JV::obj();
            p.set("status", name);
            p.set("type", typeName(t));
            p.set("index", i - 1);
            if (ctx && ci > 0) {
              JV c = JV::obj();
              c.set("type", typeName(ct));
              c.set("index", ci - 1);
              p.set("in", std::move(c));
            }
            v.problems.push(std::move(p));
          }
        };
        try {
          addList(r->Status(), nullptr);
        } catch (const Standard_Failure&) {
        }
        for (r->InitContextIterator(); r->MoreShapeInContext(); r->NextShapeInContext())
          addList(r->StatusOnShape(), &r->ContextualShape());
      }
    }
    std::ostringstream os;
    os << "invalid result (BRepCheck): ";
    if (v.counts.empty()) os << "the shape is not valid";
    bool first = true;
    for (auto& kv : v.counts) {
      os << (first ? "" : ", ") << kv.first << " x" << kv.second;
      first = false;
    }
    v.reason = os.str();
  }
  v.ms = nowMs() - t0;
  return v;
}

void putValidity(JV& r, const Validity& v) {
  r.set("valid", v.valid);
  r.set("check_ms", v.ms);
  if (!v.valid) {
    r.set("reason", v.reason);
    r.set("problems", v.problems);
    JV c = JV::obj();
    for (auto& kv : v.counts) c.set(kv.first, kv.second);
    r.set("problem_counts", std::move(c));
    r.set("problem_total", v.total);
  }
}

// Adds `valid` (and the reasons) for the stored shape `id`, unless {"check":false}.
void addValidity(JV& r, int id, const JV& q) {
  if (!q.boolean("check", true)) {
    r.set("checked", false);
    return;
  }
  putValidity(r, analyse(shapeOf(id)));
}

// --------------------------------------------------------------- profile ---

struct Seg {
  std::string id, kind;
  gp_Pnt2d a, b, c;
  double r = 0, a0 = 0, a1 = 0;
  bool ccw = true;
};

struct Step {
  const Seg* s;
  bool flip;
};

const double kDeg = M_PI / 180.0;

gp_Pnt2d uv(const JV& a) {
  if (!a.isArr() || a.size() != 2) throw InputError("expected [u,v]");
  return gp_Pnt2d(a[0].num(), a[1].num());
}

gp_Pnt2d arcPt(const Seg& s, double deg) {
  return gp_Pnt2d(s.c.X() + s.r * cos(deg * kDeg), s.c.Y() + s.r * sin(deg * kDeg));
}

gp_Pnt2d segStart(const Seg& s) { return s.kind == "line" ? s.a : arcPt(s, s.a0); }
gp_Pnt2d segEnd(const Seg& s) { return s.kind == "line" ? s.b : arcPt(s, s.a1); }

// Sweep in degrees (positive) of an arc in its own direction.
double arcSweep(const Seg& s) {
  double d = s.ccw ? s.a1 - s.a0 : s.a0 - s.a1;
  d = fmod(d, 360.0);
  if (d <= 1e-12) d += 360.0;
  return d;
}

// Points along a step, in traversal order, excluding the end point.
void stepSamples(const Step& st, std::vector<gp_Pnt2d>& out) {
  const Seg& s = *st.s;
  if (s.kind == "line") {
    out.push_back(st.flip ? s.b : s.a);
    return;
  }
  double sw = arcSweep(s);
  int n = 32;
  for (int k = 0; k < n; ++k) {
    double t = sw * k / n;
    double ang;
    if (!st.flip) ang = s.ccw ? s.a0 + t : s.a0 - t;
    else ang = s.ccw ? s.a1 - t : s.a1 + t;
    out.push_back(arcPt(s, ang));
  }
}

double signedArea(const std::vector<Step>& chain) {
  std::vector<gp_Pnt2d> pts;
  for (auto& st : chain) stepSamples(st, pts);
  double a = 0;
  for (size_t i = 0; i < pts.size(); ++i) {
    const gp_Pnt2d& p = pts[i];
    const gp_Pnt2d& q = pts[(i + 1) % pts.size()];
    a += p.X() * q.Y() - q.X() * p.Y();
  }
  return 0.5 * a;
}

struct Profile {
  gp_Ax3 ax;
  TopoDS_Face face;
  std::vector<std::pair<std::string, TopoDS_Edge>> segEdges;
  std::vector<Seg> storage;
};

std::unique_ptr<Profile> buildProfile(const JV& jp, double shiftAlongNormal) {
  std::unique_ptr<Profile> P(new Profile());
  const JV& pl = jp.req("plane");
  gp_Pnt o = pnt(pl.req("origin"));
  gp_Dir n = dir(pl.req("normal"));
  gp_Dir x = pl.has("xdir") ? dir(pl.req("xdir")) : (fabs(n.Z()) < 0.9 ? gp_Dir(0, 0, 1).Crossed(n) : gp_Dir(1, 0, 0));
  // Make xdir orthogonal to the normal.
  gp_Vec xv(x.XYZ());
  xv -= gp_Vec(n.XYZ()) * xv.Dot(gp_Vec(n.XYZ()));
  if (xv.Magnitude() < 1e-9) throw InputError("plane xdir is parallel to its normal");
  x = gp_Dir(xv);
  o.Translate(gp_Vec(n.XYZ()) * shiftAlongNormal);
  P->ax = gp_Ax3(o, n, x);
  const gp_Ax3& ax = P->ax;
  auto to3 = [&](const gp_Pnt2d& q) {
    return gp_Pnt(ax.Location().XYZ() + ax.XDirection().XYZ() * q.X() + ax.YDirection().XYZ() * q.Y());
  };

  const JV& loops = jp.req("loops");
  if (!loops.isArr() || loops.size() == 0) throw InputError("profile needs at least one loop");
  size_t total = 0;
  for (auto& L : loops.items()) total += L.size();
  P->storage.reserve(total);

  double scale = 1;
  std::vector<std::vector<Seg*>> loopSegs;
  std::map<std::string, int> seen;
  for (auto& L : loops.items()) {
    if (!L.isArr() || L.size() == 0) throw InputError("empty profile loop");
    loopSegs.emplace_back();
    for (auto& js : L.items()) {
      Seg s;
      s.id = js.str("id");
      s.kind = js.str("kind");
      if (seen[s.id]++) throw InputError("duplicate segment id '" + s.id + "'");
      if (s.kind == "line") {
        s.a = uv(js.req("a"));
        s.b = uv(js.req("b"));
        if (s.a.Distance(s.b) < 1e-9) throw InputError("zero-length line '" + s.id + "'");
      } else if (s.kind == "arc" || s.kind == "circle") {
        s.c = uv(js.req("c"));
        s.r = js.num("r");
        if (!(s.r > 0)) throw InputError("radius must be > 0 on '" + s.id + "'");
        if (s.kind == "arc") {
          s.a0 = js.num("a0");
          s.a1 = js.num("a1");
          s.ccw = js.boolean("ccw", true);
        }
      } else {
        throw InputError("unknown segment kind '" + s.kind + "'");
      }
      scale = std::max({scale, fabs(s.a.X()), fabs(s.a.Y()), fabs(s.b.X()), fabs(s.b.Y()),
                        fabs(s.c.X()) + s.r, fabs(s.c.Y()) + s.r});
      P->storage.push_back(s);
      loopSegs.back().push_back(&P->storage.back());
    }
  }
  const double tol = 1e-7 * scale;

  std::vector<TopoDS_Wire> wires;
  for (size_t li = 0; li < loopSegs.size(); ++li) {
    auto& segs = loopSegs[li];
    bool outer = li == 0;
    BRepBuilderAPI_MakeWire mw;
    if (segs.size() == 1 && segs[0]->kind == "circle") {
      const Seg& s = *segs[0];
      gp_Circ circ(gp_Ax2(to3(s.c), ax.Direction(), ax.XDirection()), s.r);
      TopoDS_Edge e = BRepBuilderAPI_MakeEdge(circ).Edge();  // counter-clockwise about the normal
      P->segEdges.emplace_back(s.id, e);
      if (!outer) e.Reverse();
      mw.Add(e);
    } else {
      for (auto* s : segs)
        if (s->kind == "circle") throw InputError("a circle must be alone in its loop ('" + s->id + "')");
      // Chain the segments end to start.
      std::vector<Step> chain;
      std::vector<bool> used(segs.size(), false);
      chain.push_back({segs[0], false});
      used[0] = true;
      gp_Pnt2d cur = segEnd(*segs[0]);
      for (size_t k = 1; k < segs.size(); ++k) {
        bool found = false;
        for (size_t j = 0; j < segs.size() && !found; ++j) {
          if (used[j]) continue;
          if (segStart(*segs[j]).Distance(cur) <= tol) {
            chain.push_back({segs[j], false});
            cur = segEnd(*segs[j]);
            used[j] = found = true;
          } else if (segEnd(*segs[j]).Distance(cur) <= tol) {
            chain.push_back({segs[j], true});
            cur = segStart(*segs[j]);
            used[j] = found = true;
          }
        }
        if (!found) {
          std::ostringstream os;
          os << "profile loop " << li << " is open at (" << cur.X() << ", " << cur.Y() << ")";
          throw InputError(os.str());
        }
      }
      if (cur.Distance(segStart(*segs[0])) > tol) {
        std::ostringstream os;
        os << "profile loop " << li << " does not close (gap " << cur.Distance(segStart(*segs[0])) << ")";
        throw InputError(os.str());
      }
      double area = signedArea(chain);
      if ((outer && area < 0) || (!outer && area > 0)) {
        std::reverse(chain.begin(), chain.end());
        for (auto& st : chain) st.flip = !st.flip;
      }
      // Shared vertices at chain nodes.
      std::vector<TopoDS_Vertex> verts;
      for (auto& st : chain)
        verts.push_back(BRepBuilderAPI_MakeVertex(to3(st.flip ? segEnd(*st.s) : segStart(*st.s))).Vertex());
      for (size_t k = 0; k < chain.size(); ++k) {
        const Step& st = chain[k];
        const Seg& s = *st.s;
        const TopoDS_Vertex& v1 = verts[k];
        const TopoDS_Vertex& v2 = verts[(k + 1) % verts.size()];
        TopoDS_Edge e;
        if (s.kind == "line") {
          BRepBuilderAPI_MakeEdge me(v1, v2);
          if (!me.IsDone()) throw InputError("cannot build line '" + s.id + "'");
          e = me.Edge();
        } else {
          gp_Circ circ(gp_Ax2(to3(s.c), ax.Direction(), ax.XDirection()), s.r);
          bool ccw = s.ccw != st.flip;
          if (ccw) {
            BRepBuilderAPI_MakeEdge me(circ, v1, v2);
            if (!me.IsDone()) throw InputError("cannot build arc '" + s.id + "'");
            e = me.Edge();
          } else {
            BRepBuilderAPI_MakeEdge me(circ, v2, v1);
            if (!me.IsDone()) throw InputError("cannot build arc '" + s.id + "'");
            e = TopoDS::Edge(me.Edge().Reversed());
          }
        }
        P->segEdges.emplace_back(s.id, e);
        mw.Add(e);
        if (!mw.IsDone()) throw InputError("segment '" + s.id + "' does not connect into a wire");
      }
    }
    if (!mw.IsDone()) throw InputError("cannot build profile wire " + std::to_string(li));
    wires.push_back(mw.Wire());
  }
  BRepBuilderAPI_MakeFace mf(gp_Pln(ax), wires[0], true);
  for (size_t i = 1; i < wires.size(); ++i) mf.Add(wires[i]);
  if (!mf.IsDone()) throw InputError("cannot build a face from the profile");
  P->face = mf.Face();
  BRepCheck_Analyzer chk(P->face);
  if (!chk.IsValid()) throw InputError("profile face is invalid (self-intersecting or overlapping loops?)");
  return P;
}

// -------------------------------------------------------------------- ops ---

// `api` counts facade contract revisions: 2 = every shape op reports `valid` (with
// reasons), work copies, repair, lazy props, selectable topo, edge flags, extrude
// flip / through_all / to_face.
const int kFacadeApi = 2;

JV opVersion(const JV&) {
  JV r = JV::obj();
  r.set("occt", OCC_VERSION_COMPLETE);
  r.set("build", sizeof(void*) == 8 ? "wasm64" : "wasm32");
  r.set("api", kFacadeApi);
  return r;
}

JV opMem(const JV&) {
  JV r = JV::obj();
  struct mallinfo mi = mallinfo();
  r.set("heap_bytes", (double)emscripten_get_heap_size());
  r.set("used_bytes", (double)mi.uordblks);
  r.set("sbrk_top", (double)(uintptr_t)sbrk(0));
  r.set("shapes", (double)g_store.size());
  r.set("alloc_failures", (double)g_allocFail);
  r.set("reserve", g_reserve != nullptr);
  return r;
}

JV opRelease(const JV& q) {
  if (q.boolean("all", false)) {
    g_store.clear();
  } else {
    for (auto& v : q.req("ids").items()) g_store.erase((int)v.num());
  }
  return JV::obj();
}

// A new shape from an op: stored, with its validity.
JV shapeResult(const TopoDS_Shape& s, const JV& q) {
  int id = putShape(s);
  JV r = JV::obj();
  r.set("id", id);
  addValidity(r, id, q);
  return r;
}

double positive(const JV& q, const char* key) {
  double v = q.num(key);
  if (!(v > 0)) throw InputError(std::string(key) + " must be > 0");
  return v;
}

JV opBox(const JV& q) {
  gp_Pnt o = pntOr(q, "origin", gp_Pnt(0, 0, 0));
  BRepPrimAPI_MakeBox mb(o, positive(q, "dx"), positive(q, "dy"), positive(q, "dz"));
  return shapeResult(mb.Shape(), q);
}

JV opCylinder(const JV& q) {
  gp_Pnt o = pntOr(q, "origin", gp_Pnt(0, 0, 0));
  gp_Dir d = q.has("axis") ? dir(q.req("axis")) : gp_Dir(0, 0, 1);
  BRepPrimAPI_MakeCylinder mc(gp_Ax2(o, d), positive(q, "r"), positive(q, "h"));
  return shapeResult(mc.Shape(), q);
}

JV opSphere(const JV& q) {
  gp_Pnt c = pntOr(q, "center", gp_Pnt(0, 0, 0));
  BRepPrimAPI_MakeSphere ms(c, positive(q, "r"));
  return shapeResult(ms.Shape(), q);
}

// Index of a face (or of the first face inside a shell/compound) in the output shape.
int faceIndexIn(int outId, const TopoDS_Shape& f) {
  if (f.IsNull()) return -1;
  Indexed& ix = indexOf(outId);
  if (f.ShapeType() == TopAbs_FACE) return ix.f.FindIndex(f) - 1;
  for (TopExp_Explorer ex(f, TopAbs_FACE); ex.More(); ex.Next()) {
    int k = ix.f.FindIndex(ex.Current());
    if (k) return k - 1;
  }
  return -1;
}

// Fallback when a builder reports no generated face (OCCT's full 360 degree revolve
// does this for planar faces): the face of the output that contains the profile
// edge's midpoint, provided exactly one unassigned face does.
int faceContainingEdge(int outId, const TopoDS_Edge& e, const std::vector<bool>& taken) {
  BRepAdaptor_Curve c(e);
  gp_Pnt m = c.Value(0.5 * (c.FirstParameter() + c.LastParameter()));
  TopoDS_Vertex v = BRepBuilderAPI_MakeVertex(m).Vertex();
  Indexed& ix = indexOf(outId);
  int found = -1;
  for (int i = 1; i <= ix.f.Extent(); ++i) {
    if (taken[i - 1]) continue;
    BRepExtrema_DistShapeShape d(v, ix.f(i));
    if (d.IsDone() && d.Value() < 1e-6) {
      if (found >= 0) return -1;  // ambiguous
      found = i - 1;
    }
  }
  return found;
}

// Side faces and caps of a swept profile.
template <class GenFn>
JV sweepHistory(int outId, const Profile& P, GenFn generated, const TopoDS_Shape& first,
                const TopoDS_Shape& last, const std::vector<bool>* onAxis = nullptr) {
  JV hist = JV::obj();
  JV faces = JV::arr();
  JV sides = JV::obj();
  JV axisSegs = JV::arr();
  std::vector<int> sideIdx(P.segEdges.size(), -1);
  std::vector<bool> taken(indexOf(outId).f.Extent(), false);
  for (size_t k = 0; k < P.segEdges.size(); ++k) {
    TopTools_ListOfShape gens = generated(P.segEdges[k].second);
    for (TopTools_ListIteratorOfListOfShape it(gens); it.More(); it.Next()) {
      if (it.Value().ShapeType() != TopAbs_FACE) continue;
      int fi = faceIndexIn(outId, it.Value());
      if (fi >= 0) {
        sideIdx[k] = fi;
        taken[fi] = true;
        break;
      }
    }
  }
  for (int cap : {faceIndexIn(outId, first), faceIndexIn(outId, last)})
    if (cap >= 0) taken[cap] = true;
  for (size_t k = 0; k < P.segEdges.size(); ++k) {
    if (sideIdx[k] >= 0) continue;
    if (onAxis && (*onAxis)[k]) continue;  // sweeps no face
    sideIdx[k] = faceContainingEdge(outId, P.segEdges[k].second, taken);
    if (sideIdx[k] >= 0) taken[sideIdx[k]] = true;
  }
  for (size_t k = 0; k < P.segEdges.size(); ++k) {
    const auto& se = P.segEdges[k];
    int fi = sideIdx[k];
    if (fi < 0 && onAxis && (*onAxis)[k]) {
      axisSegs.push(JV(se.first));
      continue;
    }
    if (fi < 0) throw OcctError("no side face generated for segment '" + se.first + "'");
    sides.set(se.first, fi);
    JV f = JV::obj();
    f.set("out", fi);
    JV from = JV::arr();
    JV src = JV::obj();
    src.set("seg", se.first);
    src.set("how", "generated");
    from.push(std::move(src));
    f.set("from", std::move(from));
    faces.push(std::move(f));
  }
  int s = faceIndexIn(outId, first), e = faceIndexIn(outId, last);
  for (auto cap : {std::make_pair("start", s), std::make_pair("end", e)}) {
    if (cap.second < 0) continue;
    JV f = JV::obj();
    f.set("out", cap.second);
    JV from = JV::arr();
    JV src = JV::obj();
    src.set("cap", cap.first);
    src.set("how", "generated");
    from.push(std::move(src));
    f.set("from", std::move(from));
    faces.push(std::move(f));
  }
  hist.set("faces", std::move(faces));
  hist.set("edges", JV::arr());
  hist.set("deleted", JV::arr());
  hist.set("sides", std::move(sides));
  if (onAxis) hist.set("on_axis", std::move(axisSegs));
  hist.set("start", s >= 0 ? JV(s) : JV());
  hist.set("end", e >= 0 ? JV(e) : JV());
  return hist;
}

// The 8 corners of a (fast, tolerance-padded) bounding box of shapes.
std::vector<gp_Pnt> boxCorners(const std::vector<TopoDS_Shape>& shapes) {
  Bnd_Box b;
  for (auto& s : shapes) BRepBndLib::Add(s, b, false);
  if (b.IsVoid()) throw InputError("the target has no geometry");
  double x0, y0, z0, x1, y1, z1;
  b.Get(x0, y0, z0, x1, y1, z1);
  std::vector<gp_Pnt> c;
  for (double x : {x0, x1})
    for (double y : {y0, y1})
      for (double z : {z0, z1}) c.emplace_back(x, y, z);
  return c;
}

// Faces of `from` as they end up in `res` after a boolean (modified, or kept as is).
TopTools_ListOfShape throughBoolean(BRepAlgoAPI_BooleanOperation& bop, const TopTools_ListOfShape& from) {
  TopTools_ListOfShape out;
  for (TopTools_ListIteratorOfListOfShape it(from); it.More(); it.Next()) {
    const TopTools_ListOfShape& mods = bop.Modified(it.Value());
    if (!mods.IsEmpty()) {
      for (TopTools_ListIteratorOfListOfShape m(mods); m.More(); m.Next()) out.Append(m.Value());
    } else if (!bop.IsDeleted(it.Value())) {
      out.Append(it.Value());
    }
  }
  return out;
}

TopoDS_Shape firstThroughBoolean(BRepAlgoAPI_BooleanOperation& bop, const TopoDS_Shape& s) {
  if (s.IsNull()) return s;
  TopTools_ListOfShape one;
  one.Append(s);
  TopTools_ListOfShape out = throughBoolean(bop, one);
  return out.IsEmpty() ? TopoDS_Shape() : out.First();
}

// Extrude a profile. The direction is the profile plane's normal, or the opposite
// with {"flip":true}. `extent` (distances along that direction, mm):
//   {kind:"blind", d}         from the profile to d (d < 0 goes the other way)
//   {kind:"symmetric", d}     d/2 each side of the profile
//   {kind:"two", d1, d2}      d1 along the direction, d2 against it
//   {kind:"through_all", targets:[id], both?}  past everything in `targets` (both sides with both:true)
//   {kind:"to_face", target:id, face:i, offset?}  up to the plane of a planar face of
//                             `target` (the end cap lies on that plane, tilted or not;
//                             offset moves it further along the direction)
// through_all and to_face are kernel-only for now (not offered in the UI).
// History: side face per profile segment, `start` (the cap the sweep starts from)
// and `end`. The result also says the span used: `from`/`to` along the direction.
JV opExtrude(const JV& q) {
  const JV& ext = q.req("extent");
  const std::string kind = ext.str("kind", "blind");
  const bool flip = q.boolean("flip", false);
  const double taper = q.num("taper_deg", 0);
  const bool tapered = fabs(taper) >= 1e-12;
  const JV& jprof = q.req("profile");
  // The profile where it was sketched: its plane, and its extent for through_all/to_face.
  auto P0 = buildProfile(jprof, 0);
  const gp_Dir n = P0->ax.Direction();
  const gp_Dir de = flip ? n.Reversed() : n;
  const gp_Pnt o = P0->ax.Location();
  const double sigma = flip ? -1.0 : 1.0;

  double s0 = 0, L = 0;  // the sweep starts at s0 and runs L along `de`
  bool clipToPlane = false;
  gp_Pln clipPlane;
  gp_Pnt clipRef;
  if (kind == "blind") {
    L = ext.num("d");
  } else if (kind == "symmetric") {
    L = fabs(ext.num("d"));
    s0 = -L / 2;
  } else if (kind == "two") {
    double d1 = ext.num("d1"), d2 = ext.num("d2");
    L = d1 + d2;
    s0 = -d2;
  } else if (kind == "through_all") {
    if (tapered) throw InputError("taper is not available with a through-all extent");
    std::vector<TopoDS_Shape> targets;
    for (auto& x : ext.req("targets").items()) targets.push_back(shapeOf(idParam(x, "targets")));
    if (targets.empty()) throw InputError("through_all needs at least one target body");
    std::vector<gp_Pnt> c = boxCorners(targets);
    double tmin = 1e300, tmax = -1e300;
    for (auto& p : c) {
      double t = gp_Vec(o, p).Dot(gp_Vec(de.XYZ()));
      tmin = std::min(tmin, t);
      tmax = std::max(tmax, t);
    }
    const double margin = 0.01 * c.front().Distance(c.back()) + 1.0;
    if (ext.boolean("both", false)) {
      s0 = std::min(tmin, 0.0) - margin;
      L = std::max(tmax, 0.0) + margin - s0;
    } else {
      if (tmax <= 1e-9) throw InputError("there is nothing to go through in this direction (flip it)");
      s0 = 0;
      L = tmax + margin;
    }
  } else if (kind == "to_face") {
    if (tapered) throw InputError("taper is not available with a to-face extent");
    const int tid = idParam(ext.req("target"), "target");
    TopoDS_Face F = faceAt(tid, ext.req("face"));
    BRepAdaptor_Surface as(F, false);
    if (as.GetType() != GeomAbs_Plane) throw InputError("to_face needs a planar face");
    gp_Pln pl = as.Plane();
    gp_Dir nf = pl.Axis().Direction();
    const double denom = gp_Vec(de.XYZ()).Dot(gp_Vec(nf.XYZ()));
    if (fabs(denom) < 1e-9) throw InputError("the face is parallel to the extrude direction");
    // offset moves the end plane further along the extrude direction.
    const double offset = ext.num("offset", 0);
    gp_Pnt p0 = pl.Location().Translated(gp_Vec(de.XYZ()) * offset);
    Bnd_Box pb;
    BRepBndLib::Add(P0->face, pb, false);
    double x0, y0, z0, x1, y1, z1;
    pb.Get(x0, y0, z0, x1, y1, z1);
    double tmin = 1e300, tmax = -1e300;
    for (double x : {x0, x1})
      for (double y : {y0, y1})
        for (double z : {z0, z1}) {
          double t = gp_Vec(gp_Pnt(x, y, z), p0).Dot(gp_Vec(nf.XYZ())) / denom;
          tmin = std::min(tmin, t);
          tmax = std::max(tmax, t);
        }
    if (tmax <= 1e-9) throw InputError("the face is behind the profile (flip the direction)");
    if (tmin <= 1e-9) throw InputError("the face's plane crosses the profile");
    if (tmax - tmin <= 1e-9 * std::max(1.0, tmax)) {
      L = 0.5 * (tmin + tmax);  // parallel planes: a blind extrude of that length
    } else {
      clipToPlane = true;
      clipPlane = gp_Pln(p0, nf);
      L = tmax + 0.01 * (tmax - tmin) + 1.0;
      // A point surely on the profile's side of the plane: the profile's box centre,
      // moved back 1 mm (every profile box corner is before the plane).
      clipRef = gp_Pnt(0.5 * (x0 + x1), 0.5 * (y0 + y1), 0.5 * (z0 + z1)).Translated(gp_Vec(de.XYZ()) * -1.0);
    }
  } else {
    throw InputError("unknown extent kind '" + kind + "'");
  }
  if (fabs(L) < 1e-9) throw InputError("extrude distance is zero");
  if (tapered && fabs(taper * kDeg) >= 0.5 * M_PI - 1e-6) throw InputError("taper must be between -90 and 90 degrees");

  JV r = JV::obj();
  auto P = buildProfile(jprof, s0 * sigma);
  if (!tapered) {
    gp_Vec v(de.XYZ());
    v *= L;
    BRepPrimAPI_MakePrism mp(P->face, v, false, true);
    mp.Build();
    if (!mp.IsDone()) throw OcctError("extrude failed");
    if (!clipToPlane) {
      int id = putShape(mp.Shape());
      r.set("id", id);
      r.set("history", sweepHistory(
                           id, *P, [&](const TopoDS_Shape& e) { return mp.Generated(e); }, mp.FirstShape(),
                           mp.LastShape()));
      addValidity(r, id, q);
    } else {
      // Keep the part of the prism before the face's plane (on the profile's side).
      TopoDS_Face hsFace = BRepBuilderAPI_MakeFace(clipPlane).Face();
      TopoDS_Shape hs = BRepPrimAPI_MakeHalfSpace(hsFace, clipRef).Solid();
      BRepAlgoAPI_Common com;
      TopTools_ListOfShape A, T;
      A.Append(mp.Shape());
      T.Append(hs);
      com.SetArguments(A);
      com.SetTools(T);
      com.SetRunParallel(false);
      com.SetToFillHistory(true);
      com.Build();
      if (com.HasErrors()) throw OcctError("extrude to face failed while clipping at the face's plane");
      TopoDS_Shape res = unwrap(com.Shape());
      int id = putShape(res);
      r.set("id", id);
      TopoDS_Shape endCap;
      for (TopExp_Explorer ex(hs, TopAbs_FACE); ex.More() && endCap.IsNull(); ex.Next())
        endCap = firstThroughBoolean(com, ex.Current());
      r.set("history", sweepHistory(
                           id, *P, [&](const TopoDS_Shape& e) { return throughBoolean(com, mp.Generated(e)); },
                           firstThroughBoolean(com, mp.FirstShape()), endCap));
      addValidity(r, id, q);
    }
  } else {
    // LocOpe_DPrism measures its height along the drafted wall and sweeps along the
    // profile plane's normal; positive taper narrows the section away from the start.
    // A sweep against the normal is built along it and mirrored through the profile
    // plane (the profile maps onto itself), so the taper keeps its sense.
    const double a = taper * kDeg;
    const double sN = s0 * sigma, LN = L * sigma;  // along the plane normal
    const bool mirror = LN < 0;
    auto PT = mirror ? buildProfile(jprof, -sN) : std::move(P);
    LocOpe_DPrism dp(PT->face, fabs(LN) / cos(a), a);
    if (!dp.IsDone()) throw OcctError("tapered extrude failed");
    if (!mirror) {
      int id = putShape(dp.Shape());
      r.set("id", id);
      r.set("history", sweepHistory(
                           id, *PT, [&](const TopoDS_Shape& e) { return dp.Shapes(e); }, dp.FirstShape(),
                           dp.LastShape()));
      addValidity(r, id, q);
    } else {
      gp_Trsf m;
      m.SetMirror(gp_Ax2(o, n));
      BRepBuilderAPI_Transform tf(dp.Shape(), m, true);
      if (!tf.IsDone()) throw OcctError("tapered extrude failed (mirror)");
      int id = putShape(tf.Shape());
      r.set("id", id);
      // Faces of the unmirrored prism -> the same faces of the mirrored result (shapes
      // that are not part of the prism, if any, are skipped).
      auto mapFace = [&](const TopoDS_Shape& f, TopTools_ListOfShape& out) {
        try {
          out.Append(tf.ModifiedShape(f));
        } catch (const Standard_Failure&) {
        }
      };
      auto viaMirror = [&](const TopTools_ListOfShape& in) {
        TopTools_ListOfShape out;
        for (TopTools_ListIteratorOfListOfShape it(in); it.More(); it.Next()) mapFace(it.Value(), out);
        return out;
      };
      auto capViaMirror = [&](const TopoDS_Shape& cap) -> TopoDS_Shape {
        if (cap.IsNull()) return cap;
        TopTools_ListOfShape out;
        for (TopExp_Explorer ex(cap, TopAbs_FACE); ex.More(); ex.Next()) mapFace(ex.Current(), out);
        return out.IsEmpty() ? TopoDS_Shape() : out.First();
      };
      // The profile edges were built on the unmirrored side; the history's fallback
      // (a face through the edge's midpoint) needs them where the result is.
      Profile mirrored;
      mirrored.ax = PT->ax;
      for (auto& se : PT->segEdges)
        mirrored.segEdges.emplace_back(se.first, TopoDS::Edge(BRepBuilderAPI_Transform(se.second, m, true).Shape()));
      r.set("history", sweepHistory(
                           id, mirrored, [&](const TopoDS_Shape& e) {
                             for (auto& se : PT->segEdges)
                               for (auto& me : mirrored.segEdges)
                                 if (me.second.IsSame(e) && me.first == se.first) return viaMirror(dp.Shapes(se.second));
                             return TopTools_ListOfShape();
                           },
                           capViaMirror(dp.FirstShape()), capViaMirror(dp.LastShape())));
      addValidity(r, id, q);
    }
  }
  r.set("from", s0);
  r.set("to", s0 + L);
  r.set("direction", d3(de));
  return r;
}

JV opRevolve(const JV& q) {
  auto P = buildProfile(q.req("profile"), 0);
  const JV& ax = q.req("axis");
  gp_Pnt o;
  gp_Dir d;
  const JV& jo = ax.req("origin");
  const JV& jd = ax.req("dir");
  if (jo.size() == 2) {  // plane (u,v) coordinates
    gp_Pnt2d u = uv(jo);
    o = gp_Pnt(P->ax.Location().XYZ() + P->ax.XDirection().XYZ() * u.X() + P->ax.YDirection().XYZ() * u.Y());
  } else {
    o = pnt(jo);
  }
  if (jd.size() == 2) {
    gp_Vec dv(P->ax.XDirection().XYZ() * jd[0].num() + P->ax.YDirection().XYZ() * jd[1].num());
    if (dv.Magnitude() < 1e-12) throw InputError("zero-length axis");
    d = gp_Dir(dv);
  } else {
    d = dir(jd);
  }
  double ang = q.num("angle_deg", 360);
  bool full = fabs(ang) >= 360 - 1e-9;
  BRepPrimAPI_MakeRevol mr(P->face, gp_Ax1(o, d), full ? 2 * M_PI : ang * kDeg, false);
  mr.Build();
  if (!mr.IsDone()) throw OcctError("revolve failed");
  int id = putShape(mr.Shape());
  JV r = JV::obj();
  r.set("id", id);
  TopoDS_Shape first = full ? TopoDS_Shape() : mr.FirstShape();
  TopoDS_Shape last = full ? TopoDS_Shape() : mr.LastShape();
  // Profile segments lying on the axis sweep no face.
  const gp_Lin axisLine(o, d);
  std::vector<bool> onAxis(P->segEdges.size(), false);
  for (size_t k = 0; k < P->segEdges.size(); ++k) {
    BRepAdaptor_Curve c(P->segEdges[k].second);
    const double f = c.FirstParameter(), l = c.LastParameter();
    bool on = true;
    for (double t : {f, 0.25 * (3 * f + l), 0.5 * (f + l), 0.25 * (f + 3 * l), l})
      if (axisLine.Distance(c.Value(t)) > 1e-7) on = false;
    onAxis[k] = on;
  }
  r.set("history", sweepHistory(
                       id, *P, [&](const TopoDS_Shape& e) { return mr.Generated(e); }, first, last, &onAxis));
  addValidity(r, id, q);
  return r;
}

std::vector<int> idList(const JV& q, const char* key, bool required) {
  std::vector<int> out;
  const JV* v = q.get(key);
  if (!v || v->isNull()) {
    if (required) throw InputError(std::string("missing parameter '") + key + "'");
    return out;
  }
  for (auto& x : v->items()) {
    int id = idParam(x, key);
    shapeOf(id);  // validate
    out.push_back(id);
  }
  return out;
}

template <class A>
std::string algoErrors(const A& a) {
  std::ostringstream os;
  a.DumpErrors(os);
  std::string s = os.str();
  while (!s.empty() && (s.back() == '\n' || s.back() == ' ')) s.pop_back();
  return s.empty() ? "unknown error" : s;
}

template <class A>
std::string algoWarnings(const A& a) {
  if (!a.HasWarnings()) return std::string();
  std::ostringstream os;
  a.DumpWarnings(os);
  std::string s = os.str();
  while (!s.empty() && (s.back() == '\n' || s.back() == ' ')) s.pop_back();
  return s;
}

// Join / cut / intersect (fuse / cut / common), several targets and several tools.
//   fuzzy: extra tolerance (mm) for nearly coincident geometry (0 = OCCT's default)
//   glue: "off" (default) | "shift" (touching or partly shared faces) | "full"
//         (fully coincident faces): OCCT's gluing modes, faster and more robust
//         when the inputs only touch; wrong results if they really intersect.
//   unify: merge same-domain faces and edges afterwards (default true), with history.
// Runs on work copies of every input. Reports `valid` (BRepCheck) and the reasons:
// OCCT can finish a fuse "successfully" with an invalid solid (P0 verify).
JV opBoolean(const JV& q) {
  std::string kind = q.str("op", q.str("kind", ""));
  std::vector<int> targets = idList(q, "targets", true);
  std::vector<int> tools = idList(q, "tools", false);
  if (targets.empty()) throw InputError("boolean needs at least one target");
  if (kind == "fuse" && tools.empty()) {
    if (targets.size() < 2) throw InputError("fuse needs two bodies");
    tools.assign(targets.begin() + 1, targets.end());
    targets.resize(1);
  }
  if (tools.empty()) throw InputError("boolean needs at least one tool");
  std::unique_ptr<BRepAlgoAPI_BooleanOperation> algo;
  if (kind == "fuse") algo.reset(new BRepAlgoAPI_Fuse());
  else if (kind == "cut") algo.reset(new BRepAlgoAPI_Cut());
  else if (kind == "common") algo.reset(new BRepAlgoAPI_Common());
  else throw InputError("boolean op must be fuse, cut or common");
  const std::string glue = q.str("glue", "off");
  BOPAlgo_GlueEnum g = BOPAlgo_GlueOff;
  if (glue == "shift") g = BOPAlgo_GlueShift;
  else if (glue == "full") g = BOPAlgo_GlueFull;
  else if (glue != "off") throw InputError("glue must be off, shift or full");
  const double fuzzy = q.num("fuzzy", 0);
  if (fuzzy < 0) throw InputError("fuzzy must be >= 0");

  std::vector<int> inputs = targets;
  inputs.insert(inputs.end(), tools.begin(), tools.end());
  WorkCopies wc(inputs);
  TopTools_ListOfShape A, T;
  for (size_t k = 0; k < inputs.size(); ++k) (k < targets.size() ? A : T).Append(wc.shape(k));
  algo->SetArguments(A);
  algo->SetTools(T);
  algo->SetRunParallel(false);
  algo->SetNonDestructive(true);
  algo->SetToFillHistory(true);
  algo->SetGlue(g);
  algo->SetCheckInverted(q.boolean("check_inverted", true));
  if (fuzzy > 0) algo->SetFuzzyValue(fuzzy);
  const double t0 = nowMs();
  algo->Build();
  if (algo->HasErrors()) throw OcctError("boolean " + kind + " failed: " + algoErrors(*algo));
  TopoDS_Shape res = algo->Shape();
  Handle(BRepTools_History) hist = new BRepTools_History();
  if (!algo->History().IsNull()) hist->Merge(algo->History());
  const double t1 = nowMs();
  if (q.boolean("unify", true) && !res.IsNull()) {
    ShapeUpgrade_UnifySameDomain u(res, true, true, false);
    u.Build();
    res = u.Shape();
    hist->Merge(u.History());
  }
  const double t2 = nowMs();
  res = unwrap(res);
  int id = putShape(res);
  JV r = JV::obj();
  r.set("id", id);
  r.set("empty", countOf(res, TopAbs_FACE) == 0);
  r.set("solids", countOf(res, TopAbs_SOLID));
  r.set("warnings", algo->HasWarnings());
  std::string wtext = algoWarnings(*algo);
  if (!wtext.empty()) r.set("warning_text", wtext);
  r.set("fuzzy", fuzzy);
  r.set("glue", glue);
  r.set("history", historyForPairs(wc.pairs(), *hist, id));
  addValidity(r, id, q);
  JV tm = JV::obj();
  tm.set("copy_ms", wc.ms);
  tm.set("boolean_ms", t1 - t0);
  tm.set("unify_ms", t2 - t1);
  r.set("timings", std::move(tm));
  return r;
}

// Split a body by a plane or by another body (the tool is not changed). Pieces are
// ordered along the plane normal, or by volume (largest first) for a tool body.
// Runs on work copies. `valid` is true only if every piece is; `pieces_valid`
// and `problems` (per piece id) say which.
JV opSplit(const JV& q) {
  int sid = idParam(q.req("id"), "id");
  std::vector<int> inputs{sid};
  gp_Pnt o(0, 0, 0);
  gp_Dir n(0, 0, 1);
  bool byPlane = q.has("plane");
  if (byPlane) {
    const JV& pl = q.req("plane");
    o = pnt(pl.req("origin"));
    n = dir(pl.req("normal"));
  } else if (q.has("tool")) {
    inputs.push_back(idParam(q.req("tool"), "tool"));
  } else {
    throw InputError("split needs a plane or a tool body");
  }
  WorkCopies wc(inputs);
  const TopoDS_Shape& s = wc.shape(0);
  TopoDS_Shape tool;
  if (byPlane) {
    Bnd_Box b;
    BRepBndLib::Add(s, b, false);
    double x0, y0, z0, x1, y1, z1;
    b.Get(x0, y0, z0, x1, y1, z1);
    gp_Pnt c((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    double size = 2 * sqrt(b.SquareExtent()) + 2 * c.Distance(o) + 1;
    tool = BRepBuilderAPI_MakeFace(gp_Pln(o, n), -size, size, -size, size).Face();
  } else {
    tool = wc.shape(1);
  }
  const int wid = wc.id(0);
  TopTools_ListOfShape A, T;
  A.Append(s);
  T.Append(tool);
  BRepAlgoAPI_Splitter sp;
  sp.SetArguments(A);
  sp.SetTools(T);
  sp.SetRunParallel(false);
  sp.SetNonDestructive(true);
  sp.SetToFillHistory(true);
  sp.Build();
  if (sp.HasErrors()) throw OcctError("split failed: " + algoErrors(sp));
  std::vector<TopoDS_Shape> pieces;
  for (TopExp_Explorer ex(sp.Shape(), TopAbs_SOLID); ex.More(); ex.Next()) pieces.push_back(ex.Current());
  if (pieces.empty()) throw OcctError("split produced no solids");
  std::vector<std::pair<double, TopoDS_Shape>> keyed;
  for (auto& p : pieces) {
    GProp_GProps g;
    BRepGProp::VolumeProperties(p, g);
    gp_Vec d(o, g.CentreOfMass());
    keyed.emplace_back(byPlane ? d.Dot(gp_Vec(n.XYZ())) : -g.Mass(), p);
  }
  std::stable_sort(keyed.begin(), keyed.end(),
                   [](const auto& a, const auto& b) { return a.first < b.first; });
  Handle(BRepTools_History) h = sp.History();
  JV ids = JV::arr();
  JV per = JV::arr();
  JV deleted = JV::arr();
  JV piecesValid = JV::arr();
  JV problems = JV::obj();
  bool allValid = true;
  const bool check = q.boolean("check", true);
  double checkMs = 0;
  for (auto& kp : keyed) {
    int id = putShape(kp.second);
    ids.push(id);
    JV hj = historyForPairs({{wid, sid}}, *h, id);
    JV one = JV::obj();
    one.set("id", id);
    one.set("faces", *hj.get("faces"));
    one.set("edges", *hj.get("edges"));
    per.push(std::move(one));
    if (check) {
      Validity v = analyse(shapeOf(id));
      checkMs += v.ms;
      piecesValid.push(v.valid);
      if (!v.valid) {
        allValid = false;
        JV pv = JV::obj();
        putValidity(pv, v);
        problems.set(std::to_string(id), std::move(pv));
      }
    }
  }
  // A face is deleted only if it lands in no piece.
  {
    Indexed& in = indexOf(wid);
    for (int i = 1; i <= in.f.Extent(); ++i) {
      bool any = false;
      for (auto& v : ids.items()) {
        Indexed& out = indexOf((int)v.num());
        const TopTools_ListOfShape& mods = h->Modified(in.f(i));
        if (out.f.Contains(in.f(i))) any = true;
        for (TopTools_ListIteratorOfListOfShape it(mods); it.More() && !any; it.Next())
          if (out.f.Contains(it.Value())) any = true;
        if (any) break;
      }
      if (!any) {
        JV d = JV::obj();
        d.set("shape", sid);
        d.set("face", i - 1);
        deleted.push(std::move(d));
      }
    }
  }
  JV hist = JV::obj();
  hist.set("pieces", std::move(per));
  hist.set("deleted", std::move(deleted));
  JV r = JV::obj();
  r.set("ids", std::move(ids));
  r.set("history", std::move(hist));
  if (check) {
    r.set("valid", allValid);
    r.set("pieces_valid", std::move(piecesValid));
    r.set("check_ms", checkMs);
    if (!allValid) {
      r.set("reason", "invalid piece(s) after the split (BRepCheck); see piece_problems");
      r.set("piece_problems", std::move(problems));
    }
  } else {
    r.set("checked", false);
  }
  return r;
}

// Fillet (r) or chamfer (d) edges of a body. Runs on a work copy: the input body
// is never changed, whatever happens. OCCT failing outright (IsDone false) is
// ok:false; OCCT "succeeding" with an invalid solid is ok:true, valid:false and the
// reasons (the Vortex inlet blend does this: a 7-face, 220,515 mm3 result).
JV opFillet(const JV& q, bool chamfer) {
  int sid = idParam(q.req("id"), "id");
  const JV& edges = q.req("edges");
  if (edges.size() == 0) throw InputError("no edges given");
  for (auto& e : edges.items()) edgeAt(sid, e);  // index check against the input
  const double size = chamfer ? q.num("d") : q.num("r");
  if (!(size > 0)) throw InputError(chamfer ? "chamfer distance must be > 0" : "fillet radius must be > 0");
  WorkCopies wc({sid});
  const int wid = wc.id(0);
  const TopoDS_Shape& s = wc.shape(0);
  TopoDS_Shape res;
  Handle(BRepTools_History) h;
  TopTools_ListOfShape args;
  args.Append(s);
  const double t0 = nowMs();
  if (!chamfer) {
    BRepFilletAPI_MakeFillet mf(s);
    for (auto& e : edges.items()) mf.Add(size, edgeAt(wid, e));
    mf.Build();
    if (!mf.IsDone()) {
      std::ostringstream os;
      os << "fillet failed (" << mf.NbFaultyContours() << " faulty contours, " << mf.NbFaultyVertices()
         << " faulty vertices); the body is unchanged";
      throw OcctError(os.str());
    }
    res = mf.Shape();
    h = new BRepTools_History(args, mf);
  } else {
    BRepFilletAPI_MakeChamfer mc(s);
    for (auto& e : edges.items()) mc.Add(size, edgeAt(wid, e));
    mc.Build();
    if (!mc.IsDone()) throw OcctError("chamfer failed; the body is unchanged");
    res = mc.Shape();
    h = new BRepTools_History(args, mc);
  }
  if (res.IsNull()) throw OcctError(std::string(chamfer ? "chamfer" : "fillet") + " returned no shape; the body is unchanged");
  const double t1 = nowMs();
  int id = putShape(unwrap(res));
  JV r = JV::obj();
  r.set("id", id);
  r.set("history", historyForPairs(wc.pairs(), *h, id));
  addValidity(r, id, q);
  JV tm = JV::obj();
  tm.set("copy_ms", wc.ms);
  tm.set("op_ms", t1 - t0);
  r.set("timings", std::move(tm));
  return r;
}

// Remove faces (holes, bosses, fillets) and heal the gap (BRepAlgoAPI_Defeaturing).
JV opDefeature(const JV& q) {
  int sid = idParam(q.req("id"), "id");
  for (auto& f : q.req("faces").items()) faceAt(sid, f);  // index check against the input
  WorkCopies wc({sid});
  const int wid = wc.id(0);
  const TopoDS_Shape& s = wc.shape(0);
  BRepAlgoAPI_Defeaturing df;
  df.SetShape(s);
  for (auto& f : q.req("faces").items()) df.AddFaceToRemove(faceAt(wid, f));
  df.SetRunParallel(false);
  df.SetToFillHistory(true);
  const double t0 = nowMs();
  df.Build();
  if (df.HasErrors()) throw OcctError("defeature failed: " + algoErrors(df) + "; the body is unchanged");
  if (df.Shape().IsNull()) throw OcctError("defeature returned no shape; the body is unchanged");
  const double t1 = nowMs();
  int id = putShape(unwrap(df.Shape()));
  Handle(BRepTools_History) h = df.History();
  if (h.IsNull()) {
    TopTools_ListOfShape args;
    args.Append(s);
    h = new BRepTools_History(args, df);
  }
  JV r = JV::obj();
  r.set("id", id);
  r.set("warnings", df.HasWarnings());
  std::string wtext = algoWarnings(df);
  if (!wtext.empty()) r.set("warning_text", wtext);
  r.set("history", historyForPairs(wc.pairs(), *h, id));
  addValidity(r, id, q);
  JV tm = JV::obj();
  tm.set("copy_ms", wc.ms);
  tm.set("op_ms", t1 - t0);
  r.set("timings", std::move(tm));
  return r;
}

// Hollow a body to wall thickness t, opening the given faces.
JV opShell(const JV& q) {
  int sid = idParam(q.req("id"), "id");
  for (auto& f : q.req("faces").items()) faceAt(sid, f);  // index check against the input
  const double t = q.num("t");
  if (!(t > 0)) throw InputError("shell thickness must be > 0");
  WorkCopies wc({sid});
  const int wid = wc.id(0);
  const TopoDS_Shape& s = wc.shape(0);
  TopTools_ListOfShape rm;
  for (auto& f : q.req("faces").items()) rm.Append(faceAt(wid, f));
  const double t0 = nowMs();
  BRepOffsetAPI_MakeThickSolid mts;
  mts.MakeThickSolidByJoin(s, rm, -t, q.num("tol", 1e-3), BRepOffset_Skin, false, false, GeomAbs_Intersection);
  mts.Build();
  if (!mts.IsDone()) throw OcctError("shell failed; the body is unchanged");
  if (mts.Shape().IsNull()) throw OcctError("shell returned no shape; the body is unchanged");
  const double t1 = nowMs();
  TopTools_ListOfShape args;
  args.Append(s);
  BRepTools_History h(args, mts);
  int id = putShape(unwrap(mts.Shape()));
  JV r = JV::obj();
  r.set("id", id);
  r.set("history", historyForPairs(wc.pairs(), h, id));
  addValidity(r, id, q);
  JV tm = JV::obj();
  tm.set("copy_ms", wc.ms);
  tm.set("op_ms", t1 - t0);
  r.set("timings", std::move(tm));
  return r;
}

// Try to make an invalid body valid: ShapeFix_Shape, then (unify, default true)
// merging same-domain faces and edges, on a work copy, with history against the
// input. The result is a new body with its own `valid` and reasons; the input is
// unchanged. `fixed` says whether ShapeFix changed anything. {tol} sets ShapeFix's
// working precision (and max tolerance max(tol, max_tol)); defaults are OCCT's.
// A repair can make a body valid without making it right: callers compare what
// they can (volume, face count) before accepting it.
JV opRepair(const JV& q) {
  int sid = idParam(q.req("id"), "id");
  WorkCopies wc({sid});
  const TopoDS_Shape& s = wc.shape(0);
  const double t0 = nowMs();
  Handle(ShapeFix_Shape) sf = new ShapeFix_Shape(s);
  if (q.has("tol")) {
    const double tol = q.num("tol");
    if (!(tol > 0)) throw InputError("tol must be > 0");
    sf->SetPrecision(tol);
    sf->SetMaxTolerance(std::max(tol, q.num("max_tol", tol)));
  }
  sf->Perform();
  TopoDS_Shape res = sf->Shape();
  if (res.IsNull()) throw OcctError("repair returned no shape; the body is unchanged");
  const bool fixed = sf->Status(ShapeExtend_DONE);
  Handle(BRepTools_History) hist = new BRepTools_History();
  Handle(BRepTools_History) fixHist = sf->Context()->History();
  if (!fixHist.IsNull()) hist->Merge(fixHist);
  const double t1 = nowMs();
  if (q.boolean("unify", true)) {
    ShapeUpgrade_UnifySameDomain u(res, true, true, false);
    u.Build();
    res = u.Shape();
    hist->Merge(u.History());
  }
  const double t2 = nowMs();
  res = unwrap(res);
  int id = putShape(res);
  Indexed& a = indexOf(sid);
  Indexed& b = indexOf(id);
  JV r = JV::obj();
  r.set("id", id);
  r.set("fixed", fixed);
  JV before = JV::obj(), after = JV::obj();
  before.set("faces", a.f.Extent());
  before.set("edges", a.e.Extent());
  before.set("vertices", a.v.Extent());
  after.set("faces", b.f.Extent());
  after.set("edges", b.e.Extent());
  after.set("vertices", b.v.Extent());
  r.set("before", std::move(before));
  r.set("after", std::move(after));
  r.set("history", historyForPairs(wc.pairs(), *hist, id));
  addValidity(r, id, q);
  JV tm = JV::obj();
  tm.set("copy_ms", wc.ms);
  tm.set("fix_ms", t1 - t0);
  tm.set("unify_ms", t2 - t1);
  r.set("timings", std::move(tm));
  return r;
}

// Measurements of a body. Cheap by default, because the exact ones are slow on
// large parts (P0, 113 MB STEP: volume 20-73 s, exact bbox 87 s natively): the
// counts and a fast bounding box (BRepBndLib::Add without triangulation: padded by
// the shape's tolerances, so it always encloses the body). The rest on request:
//   volume:true -> volume (mm3) and centroid     area:true -> area (mm2)
//   bbox: "fast" (default) | "exact" (AddOptimal, no padding) | "none"
// The older bbox_mode ("optimal" = exact) is still accepted.
JV opProps(const JV& q) {
  int sid = idParam(q.req("id"), "id");
  const TopoDS_Shape& s = shapeOf(sid);
  std::string mode = q.str("bbox", "");
  if (mode.empty()) {
    const std::string legacy = q.str("bbox_mode", "fast");
    mode = legacy == "optimal" ? "exact" : legacy == "optimal_tol" ? "exact_tol" : legacy;
  }
  if (mode != "fast" && mode != "exact" && mode != "exact_tol" && mode != "none")
    throw InputError("bbox must be fast, exact or none");
  JV r = JV::obj();
  JV tm = JV::obj();
  double t0 = nowMs();
  Indexed& ix = indexOf(sid);
  r.set("faces", ix.f.Extent());
  r.set("edges", ix.e.Extent());
  r.set("vertices", ix.v.Extent());
  r.set("solids", countOf(s, TopAbs_SOLID));
  r.set("shells", countOf(s, TopAbs_SHELL));
  tm.set("counts_ms", nowMs() - t0);
  if (q.boolean("volume", false)) {
    t0 = nowMs();
    GProp_GProps vp;
    BRepGProp::VolumeProperties(s, vp);
    r.set("volume", vp.Mass());
    r.set("centroid", vp.Mass() != 0 ? p3(vp.CentreOfMass()) : JV());
    tm.set("volume_ms", nowMs() - t0);
  }
  if (q.boolean("area", false)) {
    t0 = nowMs();
    GProp_GProps sp;
    BRepGProp::SurfaceProperties(s, sp);
    r.set("area", sp.Mass());
    tm.set("area_ms", nowMs() - t0);
  }
  if (mode != "none") {
    t0 = nowMs();
    r.set("bbox", bboxJson(s, mode == "exact" ? "optimal" : mode == "exact_tol" ? "optimal_tol" : "fast"));
    tm.set("bbox_ms", nowMs() - t0);
  }
  r.set("bbox_mode", mode);
  r.set("timings", std::move(tm));
  return r;
}

// BRepCheck of a stored body: `valid`, and when false the statuses and where.
JV opCheck(const JV& q) {
  int sid = idParam(q.req("id"), "id");
  const double maxProblems = q.num("max_problems", 40);
  JV r = JV::obj();
  putValidity(r, analyse(shapeOf(sid), (size_t)std::max(0.0, maxProblems)));
  return r;
}

const char* surfType(GeomAbs_SurfaceType t) {
  switch (t) {
    case GeomAbs_Plane: return "plane";
    case GeomAbs_Cylinder: return "cylinder";
    case GeomAbs_Cone: return "cone";
    case GeomAbs_Sphere: return "sphere";
    case GeomAbs_Torus: return "torus";
    case GeomAbs_BSplineSurface:
    case GeomAbs_BezierSurface: return "bspline";
    default: return "other";
  }
}

const char* curveType(GeomAbs_CurveType t) {
  switch (t) {
    case GeomAbs_Line: return "line";
    case GeomAbs_Circle: return "circle";
    case GeomAbs_Ellipse: return "ellipse";
    case GeomAbs_BSplineCurve:
    case GeomAbs_BezierCurve: return "bspline";
    default: return "other";
  }
}

JV axisJson(const gp_Ax1& a) {
  JV o = JV::obj();
  o.set("origin", p3(a.Location()));
  o.set("dir", d3(a.Direction()));
  return o;
}

// Which of the indices [0, n) a topo selector asks for:
//   "all" (default) | "none" | [i, j, ...] | {"start": s, "count": c} (clipped to n)
std::vector<int> topoSelection(const JV& q, const char* key, int n) {
  std::vector<int> out;
  const JV* v = q.get(key);
  if (!v || v->isNull() || (v->isStr() && v->str() == "all")) {
    out.reserve(n);
    for (int i = 0; i < n; ++i) out.push_back(i);
  } else if (v->isStr() && v->str() == "none") {
  } else if (v->isBool()) {
    if (v->boolean())
      for (int i = 0; i < n; ++i) out.push_back(i);
  } else if (v->isArr()) {
    for (auto& x : v->items()) {
      int i = (int)x.num();
      if (i < 0 || i >= n) throw InputError(std::string(key) + " index " + std::to_string(i) + " out of range");
      out.push_back(i);
    }
  } else if (v->isObj()) {
    int s = (int)v->num("start", 0), c = (int)v->num("count", n);
    if (s < 0 || c < 0) throw InputError(std::string(key) + " range must not be negative");
    for (int i = s; i < std::min(n, s + c); ++i) out.push_back(i);
  } else {
    throw InputError(std::string(key) + " must be \"all\", \"none\", a list of indices or {start, count}");
  }
  return out;
}

// Naming signatures (the resolver's inputs): per face its surface type, area,
// centroid, normal/axis/radius and bounding box; per edge its type, length,
// midpoint (circle centre/radius/axis) and adjacent faces; per vertex its point.
// All of it by default (the P0 contract). On large parts ask only for what is
// needed: faces/edges/vertices select indices ([i...], {start,count} for chunks,
// "none"), face_bbox "exact" (default) | "fast" | "none", face_mass false skips
// area and centroid, edge_length false skips length. `counts` gives the totals, so
// a caller can walk a big part in chunks (src/kernel-worker/topo-chunks.ts).
JV opTopo(const JV& q) {
  int sid = idParam(q.req("id"), "id");
  Indexed& ix = indexOf(sid);
  const std::string fbox = q.str("face_bbox", "exact");
  if (fbox != "exact" && fbox != "fast" && fbox != "none") throw InputError("face_bbox must be exact, fast or none");
  const bool faceMass = q.boolean("face_mass", true);
  const bool edgeLength = q.boolean("edge_length", true);
  const std::vector<int> fsel = topoSelection(q, "faces", ix.f.Extent());
  const std::vector<int> esel = topoSelection(q, "edges", ix.e.Extent());
  const std::vector<int> vsel = topoSelection(q, "vertices", ix.v.Extent());
  JV faces = JV::arr(), edges = JV::arr(), verts = JV::arr();
  const double t0 = nowMs();
  for (int i0 : fsel) {
    const TopoDS_Face& F = TopoDS::Face(ix.f(i0 + 1));
    JV f = JV::obj();
    f.set("i", i0);
    BRepAdaptor_Surface as(F, false);
    GeomAbs_SurfaceType st = as.GetType();
    f.set("type", surfType(st));
    if (faceMass) {
      GProp_GProps g;
      BRepGProp::SurfaceProperties(F, g);
      f.set("area", g.Mass());
      f.set("centroid", g.Mass() > 0 ? p3(g.CentreOfMass()) : JV());
    }
    bool rev = F.Orientation() == TopAbs_REVERSED;
    switch (st) {
      case GeomAbs_Plane: {
        gp_Dir n = as.Plane().Axis().Direction();
        if (!as.Plane().Direct()) n.Reverse();
        if (rev) n.Reverse();
        f.set("normal", d3(n));
        break;
      }
      case GeomAbs_Cylinder:
        f.set("axis", axisJson(as.Cylinder().Axis()));
        f.set("radius", as.Cylinder().Radius());
        break;
      case GeomAbs_Cone:
        f.set("axis", axisJson(as.Cone().Axis()));
        f.set("radius", as.Cone().RefRadius());
        f.set("semi_angle_deg", as.Cone().SemiAngle() / kDeg);
        break;
      case GeomAbs_Sphere:
        f.set("axis", axisJson(as.Sphere().Position().Axis()));
        f.set("radius", as.Sphere().Radius());
        break;
      case GeomAbs_Torus:
        f.set("axis", axisJson(as.Torus().Axis()));
        f.set("radius", as.Torus().MajorRadius());
        f.set("minor_radius", as.Torus().MinorRadius());
        break;
      default: break;
    }
    if (fbox != "none") f.set("bbox", bboxJson(F, fbox == "exact" ? "optimal" : "fast"));
    faces.push(std::move(f));
  }
  const double t1 = nowMs();
  const TopTools_IndexedDataMapOfShapeListOfShape* ef = esel.empty() ? nullptr : &edgeFacesOf(sid);
  for (int i0 : esel) {
    const TopoDS_Edge& E = TopoDS::Edge(ix.e(i0 + 1));
    JV e = JV::obj();
    e.set("i", i0);
    if (BRep_Tool::Degenerated(E)) {
      e.set("type", "degenerate");
      e.set("length", 0.0);
    } else {
      BRepAdaptor_Curve c(E);
      e.set("type", curveType(c.GetType()));
      if (edgeLength) e.set("length", GCPnts_AbscissaPoint::Length(c));
      e.set("mid", p3(c.Value(0.5 * (c.FirstParameter() + c.LastParameter()))));
      if (c.GetType() == GeomAbs_Circle) {
        e.set("center", p3(c.Circle().Location()));
        e.set("radius", c.Circle().Radius());
        e.set("axis_dir", d3(c.Circle().Axis().Direction()));
      }
    }
    JV fl = JV::arr();
    int k = ef->FindIndex(E);
    if (k) {
      std::vector<int> seen;
      for (TopTools_ListIteratorOfListOfShape it((*ef)(k)); it.More(); it.Next()) {
        int fi = ix.f.FindIndex(it.Value()) - 1;
        if (fi >= 0 && std::find(seen.begin(), seen.end(), fi) == seen.end()) seen.push_back(fi);
      }
      std::sort(seen.begin(), seen.end());
      for (int fi : seen) fl.push(fi);
    }
    e.set("faces", std::move(fl));
    edges.push(std::move(e));
  }
  const double t2 = nowMs();
  for (int i0 : vsel) {
    JV v = JV::obj();
    v.set("i", i0);
    v.set("p", p3(BRep_Tool::Pnt(TopoDS::Vertex(ix.v(i0 + 1)))));
    verts.push(std::move(v));
  }
  JV r = JV::obj();
  r.set("faces", std::move(faces));
  r.set("edges", std::move(edges));
  r.set("vertices", std::move(verts));
  JV counts = JV::obj();
  counts.set("faces", ix.f.Extent());
  counts.set("edges", ix.e.Extent());
  counts.set("vertices", ix.v.Extent());
  r.set("counts", std::move(counts));
  JV tm = JV::obj();
  tm.set("faces_ms", t1 - t0);
  tm.set("edges_ms", t2 - t1);
  tm.set("vertices_ms", nowMs() - t2);
  r.set("timings", std::move(tm));
  return r;
}

// ------------------------------------------------------------ edge flags ---
// One byte per edge index (tessellate's `edge_flags` buffer), so the viewport can
// draw only real creases between different faces:
//   1 seam         the edge closes a periodic face on itself (cylinder, cone, sphere seams)
//   2 degenerated  a pole (no length; sphere and cone tips)
//   4 internal     INTERNAL/EXTERNAL inside a face (P0: the tangent inlet leaves an
//                  85.5 mm internal edge in the Vortex roof)
//   8 same_domain  between two faces on the same surface (a split left behind)
//  16 smooth       tangent-continuous between its two faces (a fillet's boundary)
//  32 free         on one face only (the boundary of an open shell)
// kEdgeHidden (seam | degenerated | internal | same_domain) are not model edges.
const uint8_t kEdgeSeam = 1, kEdgeDegenerated = 2, kEdgeInternal = 4, kEdgeSameDomain = 8, kEdgeSmooth = 16,
              kEdgeFree = 32;
const uint8_t kEdgeHidden = kEdgeSeam | kEdgeDegenerated | kEdgeInternal | kEdgeSameDomain;

bool sameSurface(const TopoDS_Face& a, const TopoDS_Face& b) {
  TopLoc_Location la, lb;
  const Handle(Geom_Surface)& sa = BRep_Tool::Surface(a, la);
  const Handle(Geom_Surface)& sb = BRep_Tool::Surface(b, lb);
  if (sa.IsNull() || sb.IsNull()) return false;
  if (sa == sb && la.IsEqual(lb)) return true;
  BRepAdaptor_Surface A(a, false), B(b, false);
  if (A.GetType() != B.GetType()) return false;
  const double lin = 1e-6, ang = 1e-9;
  switch (A.GetType()) {
    case GeomAbs_Plane: {
      gp_Pln p = A.Plane(), r = B.Plane();
      return p.Axis().Direction().IsParallel(r.Axis().Direction(), ang) && p.Distance(r.Location()) < lin;
    }
    case GeomAbs_Cylinder: {
      gp_Cylinder c = A.Cylinder(), d = B.Cylinder();
      return fabs(c.Radius() - d.Radius()) < lin && c.Axis().Direction().IsParallel(d.Axis().Direction(), ang) &&
             gp_Lin(c.Axis()).Distance(d.Location()) < lin;
    }
    case GeomAbs_Sphere: {
      gp_Sphere c = A.Sphere(), d = B.Sphere();
      return fabs(c.Radius() - d.Radius()) < lin && c.Location().Distance(d.Location()) < lin;
    }
    case GeomAbs_Cone: {
      gp_Cone c = A.Cone(), d = B.Cone();
      return c.Apex().Distance(d.Apex()) < lin && c.Axis().Direction().IsParallel(d.Axis().Direction(), ang) &&
             fabs(fabs(c.SemiAngle()) - fabs(d.SemiAngle())) < ang;
    }
    case GeomAbs_Torus: {
      gp_Torus c = A.Torus(), d = B.Torus();
      return fabs(c.MajorRadius() - d.MajorRadius()) < lin && fabs(c.MinorRadius() - d.MinorRadius()) < lin &&
             c.Location().Distance(d.Location()) < lin && c.Axis().Direction().IsParallel(d.Axis().Direction(), ang);
    }
    default: return false;
  }
}

// Outward normal of face F at the point of edge E at fraction t of its pcurve.
bool normalOnEdge(const TopoDS_Face& F, const TopoDS_Edge& E, double t, gp_Dir& n) {
  double f = 0, l = 0;
  Handle(Geom2d_Curve) pc = BRep_Tool::CurveOnSurface(E, F, f, l);
  if (pc.IsNull()) return false;
  gp_Pnt2d uv = pc->Value(f + t * (l - f));
  BRepAdaptor_Surface s(F, false);
  gp_Pnt p;
  gp_Vec du, dv;
  s.D1(uv.X(), uv.Y(), p, du, dv);
  gp_Vec nn = du.Crossed(dv);
  if (nn.Magnitude() < 1e-12) return false;
  n = gp_Dir(nn);
  if (F.Orientation() == TopAbs_REVERSED) n.Reverse();
  return true;
}

// Tangent-continuous across E: the two faces' normals agree (within 0.01 rad, which
// covers approximated blend surfaces) at three points along the edge.
bool smoothBetween(const TopoDS_Face& a, const TopoDS_Face& b, const TopoDS_Edge& E) {
  int n = 0;
  for (double t : {0.2, 0.5, 0.8}) {
    gp_Dir na, nb;
    if (!normalOnEdge(a, E, t, na) || !normalOnEdge(b, E, t, nb)) continue;
    if (na.Angle(nb) > 0.01) return false;
    ++n;
  }
  return n > 0;
}

std::vector<uint8_t> edgeFlags(int sid, bool smooth) {
  Indexed& ix = indexOf(sid);
  const auto& ef = edgeFacesOf(sid);
  std::vector<uint8_t> fl(ix.e.Extent(), 0);
  for (int fi = 1; fi <= ix.f.Extent(); ++fi) {
    const TopoDS_Face& F = TopoDS::Face(ix.f(fi));
    for (TopExp_Explorer ex(F, TopAbs_EDGE); ex.More(); ex.Next()) {
      const TopoDS_Edge& E = TopoDS::Edge(ex.Current());
      int k = ix.e.FindIndex(E);
      if (!k) continue;
      TopAbs_Orientation o = E.Orientation();
      if (o == TopAbs_INTERNAL || o == TopAbs_EXTERNAL) fl[k - 1] |= kEdgeInternal;
      if (BRep_Tool::IsClosed(E, F)) fl[k - 1] |= kEdgeSeam;
    }
  }
  for (int i = 1; i <= ix.e.Extent(); ++i) {
    const TopoDS_Edge& E = TopoDS::Edge(ix.e(i));
    uint8_t& f = fl[i - 1];
    if (BRep_Tool::Degenerated(E)) f |= kEdgeDegenerated;
    if (f & (kEdgeDegenerated | kEdgeSeam | kEdgeInternal)) continue;
    std::vector<TopoDS_Face> faces;
    int k = ef.FindIndex(E);
    if (k)
      for (TopTools_ListIteratorOfListOfShape it(ef(k)); it.More(); it.Next()) {
        bool dup = false;
        for (auto& g : faces) dup = dup || g.IsSame(it.Value());
        if (!dup) faces.push_back(TopoDS::Face(it.Value()));
      }
    if (faces.size() == 1) f |= kEdgeFree;
    if (faces.size() != 2) continue;
    if (sameSurface(faces[0], faces[1])) f |= kEdgeSameDomain;
    else if (smooth && smoothBetween(faces[0], faces[1], E)) f |= kEdgeSmooth;
  }
  return fl;
}

JV opTessellate(const JV& q) {
  int sid = idParam(q.req("id"), "id");
  const TopoDS_Shape& s = shapeOf(sid);
  Indexed& ix = indexOf(sid);
  const auto& ef = edgeFacesOf(sid);
  double lin = q.num("lin_defl", 0);
  if (!(lin > 0)) {
    Bnd_Box b;
    BRepBndLib::Add(s, b, false);
    lin = b.IsVoid() ? 0.1 : 0.001 * sqrt(b.SquareExtent());
  }
  double ang = q.num("ang_defl_deg", 20) * kDeg;
  double t0 = nowMs();
  BRepMesh_IncrementalMesh mesh(s, lin, false, ang, false);
  const int meshStatus = mesh.GetStatusFlags();
  double t1 = nowMs();

  MBuf<float> pos, nrm, epos;
  MBuf<uint32_t> ind, franges, eranges;
  std::vector<Handle(Poly_Triangulation)> faceTri(ix.f.Extent() + 1);
  std::vector<TopLoc_Location> faceLoc(ix.f.Extent() + 1);
  size_t triangles = 0;
  for (int i = 1; i <= ix.f.Extent(); ++i) {
    const TopoDS_Face& F = TopoDS::Face(ix.f(i));
    TopLoc_Location loc;
    Handle(Poly_Triangulation) tri = BRep_Tool::Triangulation(F, loc);
    franges.push((uint32_t)ind.n);
    if (tri.IsNull() || tri->NbTriangles() == 0) {
      franges.push(0);
      continue;
    }
    faceTri[i] = tri;
    faceLoc[i] = loc;
    if (!tri->HasNormals()) BRepLib_ToolTriangulatedShape::ComputeNormals(F, tri);
    const gp_Trsf& tr = loc.Transformation();
    bool identity = loc.IsIdentity();
    bool rev = F.Orientation() == TopAbs_REVERSED;
    uint32_t base = (uint32_t)(pos.n / 3);
    pos.reserve(pos.n + 3 * tri->NbNodes());
    nrm.reserve(nrm.n + 3 * tri->NbNodes());
    for (int k = 1; k <= tri->NbNodes(); ++k) {
      gp_Pnt p = tri->Node(k);
      gp_Dir d = tri->HasNormals() ? tri->Normal(k) : gp_Dir(0, 0, 1);
      if (!identity) {
        p.Transform(tr);
        d.Transform(tr);
      }
      if (rev) d.Reverse();
      pos.push((float)p.X());
      pos.push((float)p.Y());
      pos.push((float)p.Z());
      nrm.push((float)d.X());
      nrm.push((float)d.Y());
      nrm.push((float)d.Z());
    }
    ind.reserve(ind.n + 3 * tri->NbTriangles());
    for (int k = 1; k <= tri->NbTriangles(); ++k) {
      int a, b, c;
      tri->Triangle(k).Get(a, b, c);
      if (rev) std::swap(b, c);
      ind.push(base + a - 1);
      ind.push(base + b - 1);
      ind.push(base + c - 1);
    }
    triangles += tri->NbTriangles();
    franges.push((uint32_t)(3 * tri->NbTriangles()));
  }
  double t2 = nowMs();
  for (int i = 1; i <= ix.e.Extent(); ++i) {
    const TopoDS_Edge& E = TopoDS::Edge(ix.e(i));
    uint32_t start = (uint32_t)(epos.n / 3);
    std::vector<gp_Pnt> pl;
    if (!BRep_Tool::Degenerated(E)) {
      int k = ef.FindIndex(E);
      if (k) {
        for (TopTools_ListIteratorOfListOfShape it(ef(k)); it.More() && pl.empty(); it.Next()) {
          int fi = ix.f.FindIndex(it.Value());
          if (fi <= 0 || faceTri[fi].IsNull()) continue;
          Handle(Poly_PolygonOnTriangulation) pot = BRep_Tool::PolygonOnTriangulation(E, faceTri[fi], faceLoc[fi]);
          if (pot.IsNull()) continue;
          const TColStd_Array1OfInteger& nodes = pot->Nodes();
          for (int n = nodes.Lower(); n <= nodes.Upper(); ++n) {
            gp_Pnt p = faceTri[fi]->Node(nodes(n));
            if (!faceLoc[fi].IsIdentity()) p.Transform(faceLoc[fi].Transformation());
            pl.push_back(p);
          }
        }
      }
      if (pl.empty()) {
        TopLoc_Location l;
        Handle(Poly_Polygon3D) p3d = BRep_Tool::Polygon3D(E, l);
        if (!p3d.IsNull()) {
          for (int n = 1; n <= p3d->NbNodes(); ++n) {
            gp_Pnt p = p3d->Nodes()(n);
            if (!l.IsIdentity()) p.Transform(l.Transformation());
            pl.push_back(p);
          }
        }
      }
      if (pl.empty()) {
        BRepAdaptor_Curve c(E);
        GCPnts_TangentialDeflection td(c, ang, lin);
        for (int n = 1; n <= td.NbPoints(); ++n) pl.push_back(td.Value(n));
      }
    }
    for (size_t k = 0; k + 1 < pl.size(); ++k) {
      for (const gp_Pnt* p : {&pl[k], &pl[k + 1]}) {
        epos.push((float)p->X());
        epos.push((float)p->Y());
        epos.push((float)p->Z());
      }
    }
    eranges.push(start);
    eranges.push((uint32_t)(epos.n / 3) - start);
  }
  double t3 = nowMs();
  MBuf<uint8_t> eflags;
  int hidden = 0;
  if (q.boolean("edge_flags", true)) {
    std::vector<uint8_t> fl = edgeFlags(sid, q.boolean("smooth", true));
    eflags.reserve(fl.size() + 1);
    for (uint8_t f : fl) {
      eflags.push(f);
      if (f & kEdgeHidden) ++hidden;
    }
  }
  double t4 = nowMs();
  JV r = JV::obj();
  r.set("hidden_edges", hidden);
  r.set("triangles", (double)triangles);
  r.set("mesh_status", meshStatus);  // IMeshData_Status bits, 0x4 = some faces failed
  int emptyFaces = 0;
  for (int i = 1; i <= ix.f.Extent(); ++i)
    if (faceTri[i].IsNull()) ++emptyFaces;
  r.set("faces_without_triangles", emptyFaces);
  r.set("vertices", (double)(pos.n / 3));
  r.set("lin_defl", lin);
  JV tm = JV::obj();
  tm.set("mesh_ms", t1 - t0);
  tm.set("faces_ms", t2 - t1);
  tm.set("edges_ms", t3 - t2);
  tm.set("edge_flags_ms", t4 - t3);
  r.set("timings", std::move(tm));
  JV bufs = JV::arr();
  bufs.push(pos.release("positions", "f32"));
  bufs.push(nrm.release("normals", "f32"));
  bufs.push(ind.release("indices", "u32"));
  bufs.push(franges.release("face_ranges", "u32"));
  bufs.push(epos.release("edge_positions", "f32"));
  bufs.push(eranges.release("edge_ranges", "u32"));
  if (q.boolean("edge_flags", true)) bufs.push(eflags.release("edge_flags", "u8"));
  r.set("buffers", std::move(bufs));
  return r;
}

// ------------------------------------------------------------------ STEP ---

struct MemBuf : std::streambuf {
  MemBuf(char* b, size_t n) { setg(b, b, b + n); }
  pos_type seekoff(off_type off, std::ios_base::seekdir dir, std::ios_base::openmode) override {
    char* p = dir == std::ios_base::beg ? eback() + off : dir == std::ios_base::cur ? gptr() + off : egptr() + off;
    if (p < eback() || p > egptr()) return pos_type(off_type(-1));
    setg(eback(), p, egptr());
    return pos_type(p - eback());
  }
  pos_type seekpos(pos_type pos, std::ios_base::openmode m) override {
    return seekoff(off_type(pos), std::ios_base::beg, m);
  }
};

std::string labelName(const TDF_Label& L) {
  Handle(TDataStd_Name) n;
  if (!L.IsNull() && L.FindAttribute(TDataStd_Name::GetID(), n)) {
    const TCollection_ExtendedString& ext = n->Get();
    // Convert to UTF-8.
    int len = ext.LengthOfCString();
    std::string out(len + 1, '\0');
    char* buf = &out[0];
    ext.ToUTF8CString(buf);
    out.resize(strlen(out.c_str()));
    return out;
  }
  return std::string();
}

bool labelColor(const Handle(XCAFDoc_ColorTool)& ct, const TDF_Label& L, Quantity_Color& c) {
  if (L.IsNull()) return false;
  return ct->GetColor(L, XCAFDoc_ColorSurf, c) || ct->GetColor(L, XCAFDoc_ColorGen, c);
}

struct ImportItem {
  TopoDS_Shape shape;
  std::string name;
  bool hasColor = false;
  Quantity_Color color;
};

void walkLabel(const Handle(XCAFDoc_ShapeTool)& st, const Handle(XCAFDoc_ColorTool)& ct, const TDF_Label& L,
               const TopLoc_Location& parentLoc, const std::string& parentName, bool parentHasColor,
               const Quantity_Color& parentColor, std::vector<ImportItem>& out, int depth) {
  if (depth > 64) throw OcctError("assembly nesting too deep");
  TDF_Label ref = L;
  TopLoc_Location loc = parentLoc;
  std::string name = labelName(L);
  // Colour precedence: instance, then prototype, then the parent assembly.
  Quantity_Color col = parentColor, c;
  bool hasCol = parentHasColor;
  bool own = labelColor(ct, L, c);
  if (own) {
    col = c;
    hasCol = true;
  }
  if (XCAFDoc_ShapeTool::IsReference(L)) {
    XCAFDoc_ShapeTool::GetReferredShape(L, ref);
    loc = parentLoc * XCAFDoc_ShapeTool::GetLocation(L);
    if (name.empty()) name = labelName(ref);
    if (!own && labelColor(ct, ref, c)) {
      col = c;
      hasCol = true;
    }
  }
  if (name.empty()) name = parentName;
  if (XCAFDoc_ShapeTool::IsAssembly(ref)) {
    TDF_LabelSequence comps;
    XCAFDoc_ShapeTool::GetComponents(ref, comps);
    for (int i = 1; i <= comps.Length(); ++i)
      walkLabel(st, ct, comps.Value(i), loc, name, hasCol, col, out, depth + 1);
    return;
  }
  TopoDS_Shape proto = XCAFDoc_ShapeTool::GetShape(ref);
  if (proto.IsNull()) return;
  TopoDS_Shape placed = loc.IsIdentity() ? proto : proto.Moved(loc);
  bool any = false;
  int k = 0;
  for (TopExp_Explorer ex(proto, TopAbs_SOLID); ex.More(); ex.Next(), ++k) {
    any = true;
    ImportItem it;
    it.shape = loc.IsIdentity() ? ex.Current() : ex.Current().Moved(loc);
    it.name = name;
    it.hasColor = hasCol;
    it.color = col;
    TDF_Label sub;
    if (st->FindSubShape(ref, ex.Current(), sub)) {
      std::string sn = labelName(sub);
      if (!sn.empty()) it.name = sn;
      Quantity_Color sc;
      if (labelColor(ct, sub, sc)) {
        it.color = sc;
        it.hasColor = true;
      }
    }
    Quantity_Color shc;
    if (!it.hasColor && (ct->GetColor(ex.Current(), XCAFDoc_ColorSurf, shc) || ct->GetColor(ex.Current(), XCAFDoc_ColorGen, shc))) {
      it.color = shc;
      it.hasColor = true;
    }
    out.push_back(it);
  }
  if (!any) {
    // No solids: keep shells (or the shape itself) so nothing silently vanishes.
    bool shells = false;
    for (TopExp_Explorer ex(placed, TopAbs_SHELL); ex.More(); ex.Next()) {
      shells = true;
      ImportItem it;
      it.shape = ex.Current();
      it.name = name;
      it.hasColor = hasCol;
      it.color = col;
      out.push_back(it);
    }
    if (!shells && countOf(placed, TopAbs_FACE) > 0) {
      ImportItem it;
      it.shape = placed;
      it.name = name;
      it.hasColor = hasCol;
      it.color = col;
      out.push_back(it);
    }
  }
}

// sRGB 0..1, the values written in the STEP file (what CSS and hex colours use).
JV colorJson(const Quantity_Color& c) {
  double r, g, b;
  c.Values(r, g, b, Quantity_TOC_sRGB);
  return vec3(r, g, b);
}

// Linear RGB 0..1 (OCCT's internal Quantity_TOC_RGB; three.js Color.setRGB default).
JV colorJsonLinear(const Quantity_Color& c) {
  double r, g, b;
  c.Values(r, g, b, Quantity_TOC_RGB);
  return vec3(r, g, b);
}

JV opImportStep(const JV& q) {
  // Take ownership of the input bytes first, so they are freed on every path.
  const JV* jp = q.get("ptr");
  uintptr_t ptr = jp && jp->isNum() ? (uintptr_t)(uint64_t)jp->num() : 0;
  std::unique_ptr<char, void (*)(void*)> owner((char*)ptr, free);
  if (!ptr) throw InputError("null input pointer");
  size_t len = (size_t)q.num("len");
  std::string name = q.str("name", "import.step");
  bool heal = q.boolean("heal", true);
  double tol = q.num("tol", 1e-3);
  bool xcaf = q.boolean("xcaf", true);
  std::string bboxMode = q.str("bbox_mode", "fast");  // AddOptimal costs ~87 s on the 113 MB part natively

  std::vector<ImportItem> items;
  double t0 = nowMs(), t1, t2;
  if (xcaf) {
    STEPCAFControl_Reader reader;
    reader.SetColorMode(true);
    reader.SetNameMode(true);
    reader.SetLayerMode(false);
    reader.SetPropsMode(false);
    reader.SetGDTMode(false);
    reader.SetMatMode(false);
    reader.SetViewMode(false);
    reader.SetSHUOMode(false);
    {
      MemBuf mb(owner.get(), len);
      std::istream is(&mb);
      IFSelect_ReturnStatus rs = reader.ReadStream(name.c_str(), is);
      if (rs != IFSelect_RetDone) throw InputError("STEP read failed (status " + std::to_string((int)rs) + ")");
    }
    owner.reset();  // the model holds everything now
    t1 = nowMs();
    Handle(TDocStd_Document) doc;
    XCAFApp_Application::GetApplication()->NewDocument("MDTV-XCAF", doc);
    XCAFDoc_DocumentTool::SetLengthUnit(doc, 1.0, UnitsMethods_LengthUnit_Millimeter);
    if (!reader.Transfer(doc)) throw OcctError("STEP transfer failed");
    Handle(XCAFDoc_ShapeTool) st = XCAFDoc_DocumentTool::ShapeTool(doc->Main());
    Handle(XCAFDoc_ColorTool) ct = XCAFDoc_DocumentTool::ColorTool(doc->Main());
    TDF_LabelSequence roots;
    st->GetFreeShapes(roots);
    for (int i = 1; i <= roots.Length(); ++i)
      walkLabel(st, ct, roots.Value(i), TopLoc_Location(), std::string(), false, Quantity_Color(), items, 0);
    XCAFApp_Application::GetApplication()->Close(doc);
    t2 = nowMs();
  } else {
    STEPControl_Reader reader;
    {
      MemBuf mb(owner.get(), len);
      std::istream is(&mb);
      IFSelect_ReturnStatus rs = reader.ReadStream(name.c_str(), is);
      if (rs != IFSelect_RetDone) throw InputError("STEP read failed (status " + std::to_string((int)rs) + ")");
    }
    owner.reset();
    t1 = nowMs();
    reader.TransferRoots();
    TopoDS_Shape all = reader.OneShape();
    for (TopExp_Explorer ex(all, TopAbs_SOLID); ex.More(); ex.Next()) {
      ImportItem it;
      it.shape = ex.Current();
      it.name = name;
      items.push_back(it);
    }
    t2 = nowMs();
  }
  if (items.empty()) throw InputError("the STEP file has no solids or surfaces");

  if (heal) {
    for (auto& it : items) {
      Handle(ShapeFix_Shape) sf = new ShapeFix_Shape(it.shape);
      sf->SetPrecision(tol);
      sf->SetMaxTolerance(tol);
      sf->Perform();
      TopoDS_Shape fixed = sf->Shape();
      if (!fixed.IsNull()) it.shape = unwrap(fixed);
    }
  }
  double t3 = nowMs();

  JV shapes = JV::arr();
  int nf = 0, ne = 0;
  BRep_Builder bb;
  TopoDS_Compound all;
  bb.MakeCompound(all);
  for (auto& it : items) {
    int id = putShape(it.shape);
    Indexed& ix = indexOf(id);
    nf += ix.f.Extent();
    ne += ix.e.Extent();
    bb.Add(all, it.shape);
    JV s = JV::obj();
    s.set("id", id);
    s.set("name", it.name);
    s.set("color", it.hasColor ? colorJson(it.color) : JV());
    s.set("color_linear", it.hasColor ? colorJsonLinear(it.color) : JV());
    s.set("type", it.shape.ShapeType() == TopAbs_SOLID ? "solid" : it.shape.ShapeType() == TopAbs_SHELL ? "shell" : "other");
    shapes.push(std::move(s));
  }
  JV r = JV::obj();
  r.set("shapes", std::move(shapes));
  r.set("faces", nf);
  r.set("edges", ne);
  double t4 = nowMs();
  r.set("bbox", bboxJson(all, bboxMode));
  double t5 = nowMs();
  JV tm = JV::obj();
  tm.set("read_ms", t1 - t0);
  tm.set("transfer_ms", t2 - t1);
  tm.set("heal_ms", t3 - t2);
  tm.set("index_ms", t4 - t3);
  tm.set("bbox_ms", t5 - t4);
  r.set("timings", std::move(tm));
  return r;
}

JV opExportStep(const JV& q) {
  std::string schema = q.str("schema", "AP214");
  Handle(TDocStd_Document) doc;
  XCAFApp_Application::GetApplication()->NewDocument("MDTV-XCAF", doc);
  XCAFDoc_DocumentTool::SetLengthUnit(doc, 1.0, UnitsMethods_LengthUnit_Millimeter);
  Handle(XCAFDoc_ShapeTool) st = XCAFDoc_DocumentTool::ShapeTool(doc->Main());
  Handle(XCAFDoc_ColorTool) ct = XCAFDoc_DocumentTool::ColorTool(doc->Main());
  for (auto& js : q.req("shapes").items()) {
    int id = idParam(js.req("id"), "shapes[].id");
    TDF_Label L = st->AddShape(shapeOf(id), false);
    std::string nm = js.str("name", "Body");
    TDataStd_Name::Set(L, TCollection_ExtendedString(nm.c_str(), true));
    if (js.has("color")) {
      const JV& c = js.req("color");
      ct->SetColor(L, Quantity_Color(c[0].num(), c[1].num(), c[2].num(), Quantity_TOC_sRGB), XCAFDoc_ColorGen);
    }
  }
  DESTEP_Parameters p;
  p.InitFromStatic();
  if (schema == "AP242") {
    p.WriteSchema = DESTEP_Parameters::WriteMode_StepSchema_AP242DIS;
    Interface_Static::SetIVal("write.step.schema", 5);
  } else if (schema == "AP214") {
    p.WriteSchema = DESTEP_Parameters::WriteMode_StepSchema_AP214IS;
    Interface_Static::SetIVal("write.step.schema", 4);
  } else {
    throw InputError("schema must be AP214 or AP242");
  }
  p.WriteUnit = UnitsMethods_LengthUnit_Millimeter;
  STEPCAFControl_Writer w;
  w.SetColorMode(true);
  w.SetNameMode(true);
  if (!w.Transfer(doc, p, STEPControl_AsIs)) throw OcctError("STEP transfer for export failed");
  std::ostringstream os;
  if (w.WriteStream(os) != IFSelect_RetDone) throw OcctError("STEP write failed");
  XCAFApp_Application::GetApplication()->Close(doc);
  std::string data = os.str();
  MBuf<uint8_t> b;
  b.reserve(data.size() + 1);
  memcpy(b.p, data.data(), data.size());
  b.n = data.size();
  JV r = JV::obj();
  JV bufs = JV::arr();
  bufs.push(b.release("step", "u8"));
  r.set("buffers", std::move(bufs));
  return r;
}

// Deliberately exhaust memory through OCCT's allocator (gate 9 test hook).
JV opDebugOom(const JV& q) {
  size_t step = (size_t)(q.num("step_mb", 64) * 1048576.0);
  double limitMb = q.num("limit_mb", 0);
  std::vector<std::unique_ptr<void, void (*)(void*)>> held;
  size_t total = 0;
  for (;;) {
    if (limitMb > 0 && total + step > limitMb * 1048576.0) break;
    void* p = Standard::Allocate(step);  // throws Standard_OutOfMemory on failure
    held.emplace_back(p, [](void* x) { Standard::Free(x); });
    total += step;
  }
  JV r = JV::obj();
  r.set("allocated_mb", total / 1048576.0);
  r.set("reached_limit", true);
  return r;
}

// Fill the heap with malloc'd chunks and keep them (gate 9 test hook), so that a
// real modelling op then runs out of memory inside OCCT. {"free":true} releases them.
std::vector<void*> g_held;

JV opDebugHold(const JV& q) {
  JV r = JV::obj();
  if (q.boolean("free", false)) {
    size_t n = g_held.size();
    for (void* p : g_held) free(p);
    g_held.clear();
    g_held.shrink_to_fit();
    r.set("freed_chunks", (double)n);
    return r;
  }
  double leaveMb = q.num("leave_mb", 16);
  g_held.reserve(200000);
  double held = 0;
  for (size_t chunk : {(size_t)256 << 20, (size_t)16 << 20, (size_t)1 << 20, (size_t)256 << 10,
                       (size_t)64 << 10, (size_t)16 << 10, (size_t)4 << 10}) {
    while (g_held.size() < g_held.capacity()) {
      void* p = malloc(chunk);
      if (!p) break;
      g_held.push_back(p);
      held += (double)chunk;
    }
  }
  // Give back the smallest chunks until `leave_mb` is free after the reserve is restored.
  double target = leaveMb * 1048576.0 + (g_reserve ? 0.0 : (double)kReserveBytes);
  double back = 0;
  while (back < target && !g_held.empty()) {
    size_t sz = malloc_usable_size(g_held.back());
    free(g_held.back());
    g_held.pop_back();
    back += (double)sz;
    held -= (double)sz;
  }
  r.set("held_mb", held / 1048576.0);
  r.set("left_free_mb", (back - (g_reserve ? 0.0 : (double)kReserveBytes)) / 1048576.0);
  r.set("heap_bytes", (double)emscripten_get_heap_size());
  return r;
}

JV dispatch(const std::string& op, const JV& q) {
  if (op == "version") return opVersion(q);
  if (op == "mem") return opMem(q);
  if (op == "release") return opRelease(q);
  if (op == "import_step") return opImportStep(q);
  if (op == "export_step") return opExportStep(q);
  if (op == "box") return opBox(q);
  if (op == "cylinder") return opCylinder(q);
  if (op == "sphere") return opSphere(q);
  if (op == "extrude") return opExtrude(q);
  if (op == "revolve") return opRevolve(q);
  if (op == "boolean") return opBoolean(q);
  if (op == "split") return opSplit(q);
  if (op == "fillet") return opFillet(q, false);
  if (op == "chamfer") return opFillet(q, true);
  if (op == "defeature") return opDefeature(q);
  if (op == "shell") return opShell(q);
  if (op == "repair") return opRepair(q);
  if (op == "props") return opProps(q);
  if (op == "check") return opCheck(q);
  if (op == "topo") return opTopo(q);
  if (op == "tessellate") return opTessellate(q);
  if (op == "debug_oom") return opDebugOom(q);
  if (op == "debug_hold") return opDebugHold(q);
  throw InputError("unknown op '" + op + "'");
}

char* toC(const std::string& s) {
  char* p = (char*)malloc(s.size() + 1);
  if (!p) return nullptr;
  memcpy(p, s.data(), s.size());
  p[s.size()] = 0;
  return p;
}

std::string errJson(const std::string& msg, const char* kind, bool oom) {
  JV e = JV::obj();
  e.set("ok", false);
  e.set("error", msg);
  e.set("kind", kind);
  if (oom) e.set("oom", true);
  return e.dump();
}

bool g_init = false;

void initOnce() {
  if (g_init) return;
  g_init = true;
  restoreReserve();
  // Keep OCCT's console chatter out of the worker log; errors come back as JSON.
  Handle(Message_Messenger) m = Message::DefaultMessenger();
  m->RemovePrinters(STANDARD_TYPE(Message_PrinterOStream));
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE char* mk_call(const char* json) {
  std::string out;
  const size_t fail0 = g_allocFail;
  const int next0 = g_next;
  std::string op = "?";
  auto oomText = [&](const std::string& why) {
    std::ostringstream os;
    os << "out of memory during " << op << " (" << (g_allocFail - fail0) << " failed allocations";
    if (!why.empty()) os << "; " << why;
    os << ")";
    return os.str();
  };
  auto dropNew = [&]() {
    for (int id = next0; id < g_next; ++id) g_store.erase(id);
  };
  try {
    initOnce();
    if (!json) throw InputError("null request");
    JV req = JV::parse(json);
    op = req.str("op");
    const JV* params = req.get("params");
    JV res = dispatch(op, params && params->isObj() ? *params : req);
    if (g_allocFail != fail0 && op.compare(0, 6, "debug_") != 0) {
      // Something inside ran out of memory and was swallowed: do not trust the result.
      if (const JV* bufs = res.get("buffers"))
        for (auto& b : bufs->items())
          if (const JV* p = b.get("ptr")) free((void*)(uintptr_t)(uint64_t)p->num());
      dropNew();
      std::string e = errJson(oomText("result discarded"), "occt", true);
      if (!restoreReserve()) e.insert(1, "\"low_memory\":true,");
      return toC(e);
    }
    std::string body = res.dump();
    out.reserve(body.size() + 12);
    out = body.size() > 2 ? "{\"ok\":true," + body.substr(1) : "{\"ok\":true}";
  } catch (const InputError& e) {
    out = errJson(e.what(), "input", false);
  } catch (const OcctError& e) {
    out = g_allocFail != fail0 ? errJson(oomText(e.what()), "occt", true) : errJson(e.what(), "occt", false);
  } catch (const Standard_OutOfMemory& e) {
    out = errJson(oomText(failureText(e)), "occt", true);
  } catch (const Standard_Failure& e) {
    out = g_allocFail != fail0 ? errJson(oomText(failureText(e)), "occt", true) : errJson(failureText(e), "occt", false);
  } catch (const std::bad_alloc& e) {
    out = errJson(oomText(e.what()), "internal", true);
  } catch (const std::exception& e) {
    out = g_allocFail != fail0 ? errJson(oomText(e.what()), "internal", true) : errJson(e.what(), "internal", false);
  } catch (...) {
    out = errJson("unknown exception", "internal", g_allocFail != fail0);
  }
  if (g_allocFail != fail0) dropNew();
  // If the reserve cannot be restored the heap is nearly full: tell the caller to
  // recycle the worker.
  if (!restoreReserve() && out.size() > 1) out.insert(1, "\"low_memory\":true,");
  return toC(out);
}

EMSCRIPTEN_KEEPALIVE void* mk_alloc(size_t n) { return malloc(n ? n : 1); }

EMSCRIPTEN_KEEPALIVE void mk_free(void* p) { free(p); }

}  // extern "C"
