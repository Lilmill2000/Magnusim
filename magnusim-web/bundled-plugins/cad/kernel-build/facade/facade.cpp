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
#include <cctype>
#include <functional>
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
#include <TopTools_MapOfShape.hxx>
#include <gp_Vec2d.hxx>
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
#include <ShapeFix_Solid.hxx>
#include <ShapeAnalysis_Shell.hxx>
#include <BRepBuilderAPI_Sewing.hxx>
#include <BinTools.hxx>
#include <BRepTools.hxx>
#include <BRepTools_WireExplorer.hxx>
#include <TColStd_SequenceOfAsciiString.hxx>
#include <gp_Pnt2d.hxx>

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
  // What import_step read for the shape (heal carries it to its outputs): the
  // STEP name and colour. Empty for shapes made by modelling ops.
  std::string name;
  bool hasColor = false;
  Quantity_Color color;
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

// Adds `faces` (API 3: the face count, so the naming layer needs no props call)
// and `valid` (and the reasons) for the stored shape `id`, unless {"check":false}.
// Every op that makes one shape ends with this.
void addValidity(JV& r, int id, const JV& q) {
  r.set("faces", indexOf(id).f.Extent());
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
// flip / through_all / to_face; 3 = docs/p2p3-plan.md §2: `faces` on every shape
// result, import diagnostics and unit, heal, brep_write / brep_read, press_pull,
// combine, measure, sketch_regions, extrude_regions.
const int kFacadeApi = 3;

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

// The span an extent asks for: the sweep starts at s0 and runs L along the extrude
// direction `de` (distances from the profile plane). to_face with a face that is not
// parallel to the profile also clips the sweep at that face's plane (clipRef is a
// point surely on the profile's side of it).
struct ExtentPlan {
  double s0 = 0, L = 0;
  bool clip = false;
  gp_Pln clipPlane;
  gp_Pnt clipRef;
};

// Extents, as distances (mm) along the extrude direction (the profile plane's
// normal, or the opposite with {"flip":true}):
//   {kind:"blind", d}         from the profile to d (d < 0 goes the other way)
//   {kind:"symmetric", d}     d/2 each side of the profile
//   {kind:"two", d1, d2}      d1 along the direction, d2 against it
//   {kind:"through_all", targets:[id], both?}  past everything in `targets` (both sides with both:true)
//   {kind:"to_face", target:id, face:i, offset?}  up to the plane of a planar face of
//                             `target` (the end cap lies on that plane, tilted or not;
//                             offset moves it further along the direction)
// through_all and to_face are kernel-only for now (not offered in the UI). `faces`
// are the profile faces at the sketch plane (their box bounds to_face).
ExtentPlan planExtent(const JV& ext, const gp_Pnt& o, const gp_Dir& de, bool tapered, const std::vector<TopoDS_Face>& faces) {
  const std::string kind = ext.str("kind", "blind");
  ExtentPlan pl;
  double& s0 = pl.s0;
  double& L = pl.L;
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
    gp_Pln fp = as.Plane();
    gp_Dir nf = fp.Axis().Direction();
    const double denom = gp_Vec(de.XYZ()).Dot(gp_Vec(nf.XYZ()));
    if (fabs(denom) < 1e-9) throw InputError("the face is parallel to the extrude direction");
    // offset moves the end plane further along the extrude direction.
    const double offset = ext.num("offset", 0);
    gp_Pnt p0 = fp.Location().Translated(gp_Vec(de.XYZ()) * offset);
    Bnd_Box pb;
    for (auto& f : faces) BRepBndLib::Add(f, pb, false);
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
      pl.clip = true;
      pl.clipPlane = gp_Pln(p0, nf);
      L = tmax + 0.01 * (tmax - tmin) + 1.0;
      // A point surely on the profile's side of the plane: the profile's box centre,
      // moved back 1 mm (every profile box corner is before the plane).
      pl.clipRef = gp_Pnt(0.5 * (x0 + x1), 0.5 * (y0 + y1), 0.5 * (z0 + z1)).Translated(gp_Vec(de.XYZ()) * -1.0);
    }
  } else {
    throw InputError("unknown extent kind '" + kind + "'");
  }
  if (fabs(L) < 1e-9) throw InputError("extrude distance is zero");
  return pl;
}

// One swept profile and what its history needs: the faces each profile edge
// generated (`generated`, edges of `prof`), and the caps. `keep` holds the OCCT
// algorithms those functions read.
struct Sweep {
  TopoDS_Shape shape, first, last;
  std::function<TopTools_ListOfShape(const TopoDS_Shape&)> generated;
  std::shared_ptr<Profile> prof;
  std::vector<std::shared_ptr<void>> keep;
};

// The profile moved along its plane's normal by `shift` mm (symmetric and two-sided
// extents start behind the sketch plane).
using ProfileAt = std::function<std::unique_ptr<Profile>(double shift)>;

// Sweep a profile over a planned extent: a prism (clipped at a to_face plane), or with
// a taper LocOpe_DPrism. LocOpe_DPrism measures its height along the drafted wall and
// sweeps along the profile plane's normal; positive taper narrows the section away
// from the start. A sweep against the normal is built along it and mirrored through
// the profile plane (the profile maps onto itself), so the taper keeps its sense.
// o, n: the profile plane at the sketch (not shifted); de = n or -n; sigma = +-1.
Sweep sweepProfile(const ProfileAt& at, const ExtentPlan& pl, const gp_Pnt& o, const gp_Dir& n, const gp_Dir& de,
                   double sigma, double taperDeg) {
  Sweep sw;
  const bool tapered = fabs(taperDeg) >= 1e-12;
  std::shared_ptr<Profile> P(at(pl.s0 * sigma).release());
  if (!tapered) {
    gp_Vec v(de.XYZ());
    v *= pl.L;
    auto mp = std::make_shared<BRepPrimAPI_MakePrism>(P->face, v, false, true);
    mp->Build();
    if (!mp->IsDone()) throw OcctError("extrude failed");
    sw.keep.push_back(mp);
    sw.prof = P;
    if (!pl.clip) {
      sw.shape = mp->Shape();
      sw.generated = [mp](const TopoDS_Shape& e) { return mp->Generated(e); };
      sw.first = mp->FirstShape();
      sw.last = mp->LastShape();
    } else {
      // Keep the part of the prism before the face's plane (on the profile's side).
      TopoDS_Face hsFace = BRepBuilderAPI_MakeFace(pl.clipPlane).Face();
      TopoDS_Shape hs = BRepPrimAPI_MakeHalfSpace(hsFace, pl.clipRef).Solid();
      auto com = std::make_shared<BRepAlgoAPI_Common>();
      TopTools_ListOfShape A, T;
      A.Append(mp->Shape());
      T.Append(hs);
      com->SetArguments(A);
      com->SetTools(T);
      com->SetRunParallel(false);
      com->SetToFillHistory(true);
      com->Build();
      if (com->HasErrors()) throw OcctError("extrude to face failed while clipping at the face's plane");
      sw.keep.push_back(com);
      sw.shape = unwrap(com->Shape());
      TopoDS_Shape endCap;
      for (TopExp_Explorer ex(hs, TopAbs_FACE); ex.More() && endCap.IsNull(); ex.Next())
        endCap = firstThroughBoolean(*com, ex.Current());
      sw.generated = [mp, com](const TopoDS_Shape& e) { return throughBoolean(*com, mp->Generated(e)); };
      sw.first = firstThroughBoolean(*com, mp->FirstShape());
      sw.last = endCap;
    }
    return sw;
  }
  const double a = taperDeg * kDeg;
  const double sN = pl.s0 * sigma, LN = pl.L * sigma;  // along the plane normal
  const bool mirror = LN < 0;
  std::shared_ptr<Profile> PT = mirror ? std::shared_ptr<Profile>(at(-sN).release()) : P;
  auto dp = std::make_shared<LocOpe_DPrism>(PT->face, fabs(LN) / cos(a), a);
  if (!dp->IsDone()) throw OcctError("tapered extrude failed");
  sw.keep.push_back(dp);
  if (!mirror) {
    sw.shape = dp->Shape();
    sw.prof = PT;
    sw.generated = [dp](const TopoDS_Shape& e) { return dp->Shapes(e); };
    sw.first = dp->FirstShape();
    sw.last = dp->LastShape();
    return sw;
  }
  gp_Trsf m;
  m.SetMirror(gp_Ax2(o, n));
  auto tf = std::make_shared<BRepBuilderAPI_Transform>(dp->Shape(), m, true);
  if (!tf->IsDone()) throw OcctError("tapered extrude failed (mirror)");
  sw.keep.push_back(tf);
  sw.shape = tf->Shape();
  // Faces of the unmirrored prism -> the same faces of the mirrored result (shapes
  // that are not part of the prism, if any, are skipped).
  auto mapFace = [tf](const TopoDS_Shape& f, TopTools_ListOfShape& out) {
    try {
      out.Append(tf->ModifiedShape(f));
    } catch (const Standard_Failure&) {
    }
  };
  auto capViaMirror = [&](const TopoDS_Shape& cap) -> TopoDS_Shape {
    if (cap.IsNull()) return cap;
    TopTools_ListOfShape out;
    for (TopExp_Explorer ex(cap, TopAbs_FACE); ex.More(); ex.Next()) mapFace(ex.Current(), out);
    return out.IsEmpty() ? TopoDS_Shape() : out.First();
  };
  // The profile edges were built on the unmirrored side; the history's fallback
  // (a face through the edge's midpoint) needs them where the result is.
  auto mirrored = std::make_shared<Profile>();
  mirrored->ax = PT->ax;
  for (auto& se : PT->segEdges)
    mirrored->segEdges.emplace_back(se.first, TopoDS::Edge(BRepBuilderAPI_Transform(se.second, m, true).Shape()));
  sw.prof = mirrored;
  sw.generated = [dp, PT, mirrored, mapFace](const TopoDS_Shape& e) {
    for (auto& se : PT->segEdges)
      for (auto& me : mirrored->segEdges)
        if (me.second.IsSame(e) && me.first == se.first) {
          TopTools_ListOfShape out;
          const TopTools_ListOfShape& in = dp->Shapes(se.second);
          for (TopTools_ListIteratorOfListOfShape it(in); it.More(); it.Next()) mapFace(it.Value(), out);
          return out;
        }
    return TopTools_ListOfShape();
  };
  sw.first = capViaMirror(dp->FirstShape());
  sw.last = capViaMirror(dp->LastShape());
  return sw;
}

// Extrude a profile (extents: planExtent; taper: sweepProfile). History: side face
// per profile segment, `start` (the cap the sweep starts from) and `end`. The result
// also says the span used: `from`/`to` along the direction.
JV opExtrude(const JV& q) {
  const JV& ext = q.req("extent");
  const bool flip = q.boolean("flip", false);
  const double taper = q.num("taper_deg", 0);
  const bool tapered = fabs(taper) >= 1e-12;
  const JV& jprof = q.req("profile");
  // The profile where it was sketched: its plane, and its extent for to_face.
  auto P0 = buildProfile(jprof, 0);
  const gp_Dir n = P0->ax.Direction();
  const gp_Dir de = flip ? n.Reversed() : n;
  const gp_Pnt o = P0->ax.Location();
  const double sigma = flip ? -1.0 : 1.0;
  const ExtentPlan pl = planExtent(ext, o, de, tapered, {P0->face});
  if (tapered && fabs(taper * kDeg) >= 0.5 * M_PI - 1e-6) throw InputError("taper must be between -90 and 90 degrees");
  Sweep sw = sweepProfile([&](double shift) { return buildProfile(jprof, shift); }, pl, o, n, de, sigma, taper);
  JV r = JV::obj();
  int id = putShape(sw.shape);
  r.set("id", id);
  r.set("history", sweepHistory(id, *sw.prof, sw.generated, sw.first, sw.last));
  addValidity(r, id, q);
  r.set("from", pl.s0);
  r.set("to", pl.s0 + pl.L);
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
// Runs on work copies. `valid` is true only if every piece is and no input face is
// lost (`lost_faces`: a loss makes it false even with check:false); `pieces_valid`
// and `problems` (per piece id) say which. `faces` (API 3): the face count of each
// piece, in the order of `ids`.
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
  JV faceCounts = JV::arr();
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
    faceCounts.push(indexOf(id).f.Extent());
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
  // A split keeps all of the body: every input face lands in some piece. OCCT's
  // Splitter can drop whole pieces without an error (the 113 MB part split at its
  // middle X plane: one piece, half the volume, 5,989 faces gone; natively too).
  const int lost = (int)deleted.size();
  JV hist = JV::obj();
  hist.set("pieces", std::move(per));
  hist.set("deleted", std::move(deleted));
  JV r = JV::obj();
  r.set("ids", std::move(ids));
  r.set("faces", std::move(faceCounts));
  r.set("history", std::move(hist));
  r.set("lost_faces", lost);
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
  if (lost > 0) {
    // Not a BRepCheck finding, so it holds with check:false too: never a silent loss.
    r.set("valid", false);
    r.set("reason", "split lost part of the body: " + std::to_string(lost) + " of its faces are in no piece (OCCT's splitter)");
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
// The older bbox_mode ("optimal" = exact) is still accepted. volume_eps (API 3,
// with volume:true) integrates adaptively to that relative error and reports
// volume_error: the default integration is off by about 1.5e-7 on the Vortex part
// (its B-spline faces), which the reference values share.
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
    if (q.has("volume_eps")) {
      const double eps = q.num("volume_eps");
      if (!(eps > 0)) throw InputError("volume_eps must be > 0");
      r.set("volume_error", BRepGProp::VolumeProperties(s, vp, eps, Standard_False));
    } else {
      BRepGProp::VolumeProperties(s, vp);
    }
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
  if (!any && countOf(placed, TopAbs_FACE) > 0) {
    // No solids: the label's faces stay one surface body (all its shells together),
    // so nothing silently vanishes and an open model is one body to heal and knit
    // (a STEP open shell whose faces share no edge reads back as one shell per face).
    ImportItem it;
    it.shape = placed;
    TopExp_Explorer ex(placed, TopAbs_SHELL);
    if (ex.More() && countOf(placed, TopAbs_SHELL) == 1 && countOf(ex.Current(), TopAbs_FACE) == countOf(placed, TopAbs_FACE))
      it.shape = ex.Current();
    it.name = name;
    it.hasColor = hasCol;
    it.color = col;
    out.push_back(it);
  } else if (any) {
    // Solids and loose faces under one label: the faces outside the solids become one
    // surface body as well, instead of being dropped.
    BRep_Builder bb;
    TopoDS_Compound loose;
    bb.MakeCompound(loose);
    int n = 0;
    for (TopExp_Explorer ex(placed, TopAbs_FACE, TopAbs_SOLID); ex.More(); ex.Next(), ++n) bb.Add(loose, ex.Current());
    if (n) {
      ImportItem it;
      it.shape = loose;
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

// "solid" for a solid; "shell" for a surface body (faces, no solid); "other".
const char* bodyType(const TopoDS_Shape& s) {
  if (s.IsNull()) return "other";
  if (s.ShapeType() == TopAbs_SOLID) return "solid";
  if (countOf(s, TopAbs_SOLID) == 0 && countOf(s, TopAbs_FACE) > 0) return "shell";
  return "other";
}

// Edges on one face only (seams and degenerated edges excluded): the open boundary
// of a surface body. ShapeAnalysis_FreeBounds' topological count: every face in
// one shell, ShapeAnalysis_Shell's free edges.
int freeEdgeCount(const TopoDS_Shape& s) {
  TopoDS_Shell sh;
  BRep_Builder b;
  b.MakeShell(sh);
  int n = 0;
  for (TopExp_Explorer ex(s, TopAbs_FACE); ex.More(); ex.Next(), ++n) b.Add(sh, ex.Current());
  if (!n) return 0;
  ShapeAnalysis_Shell sas;
  sas.CheckOrientedShells(sh, Standard_True);
  return sas.HasFreeEdges() ? countOf(sas.FreeEdges(), TopAbs_EDGE) : 0;
}

// One shape's diagnostics for the import panel (ShapeDiagnostics in
// kernel-protocol.ts): BRepCheck problems (the first 40, indices in the shape's own
// index space), free edges, and whether it is a closed solid.
struct Diag {
  Validity v;
  int freeEdges = 0;
  bool closed = false;
  double ms = 0;
};

Diag diagnoseShape(const TopoDS_Shape& s) {
  Diag d;
  const double t0 = nowMs();
  d.v = analyse(s);
  d.freeEdges = freeEdgeCount(s);
  d.closed = countOf(s, TopAbs_SOLID) > 0 && d.freeEdges == 0;
  d.ms = nowMs() - t0;
  return d;
}

JV diagJson(int id, const Diag& d) {
  JV o = JV::obj();
  o.set("id", id);
  o.set("valid", d.v.valid);
  o.set("problems", d.v.problems);
  JV c = JV::obj();
  for (auto& kv : d.v.counts) c.set(kv.first, kv.second);
  o.set("problem_counts", std::move(c));
  o.set("problem_total", d.v.total);
  o.set("free_edges", d.freeEdges);
  o.set("closed", d.closed);
  return o;
}

// Diagnostics of several shapes: {total, shapes: [...]}.
JV diagnosticsJson(const std::vector<int>& ids, const std::vector<Diag>& ds) {
  JV r = JV::obj();
  JV shapes = JV::arr();
  int total = 0;
  for (size_t k = 0; k < ids.size(); ++k) {
    total += ds[k].v.total;
    shapes.push(diagJson(ids[k], ds[k]));
  }
  r.set("total", total);
  r.set("shapes", std::move(shapes));
  return r;
}

// The file's length unit as it declares it ("inch", "millimetre"), or null.
JV fileUnit(STEPControl_Reader& reader) {
  TColStd_SequenceOfAsciiString len, ang, solid;
  try {
    reader.FileUnits(len, ang, solid);
  } catch (const Standard_Failure&) {
    return JV();
  }
  if (len.Length() < 1) return JV();
  std::string u = len.Value(1).ToCString();
  for (auto& ch : u) ch = (char)tolower((unsigned char)ch);
  return u.empty() ? JV() : JV(u);
}

// Read a STEP (bytes in as ptr/len). One shape per solid (or one surface body per
// STEP product without solids), with the STEP name and colour. heal:true (default)
// runs ShapeFix_Shape at `tol` in the same call (`fixed` says on how many shapes it
// changed something). API 3: `unit` (the file's length unit), `faces` per shape,
// and with diagnose (default true) `diagnostics` of the shapes returned (as read
// with heal:false, healed with heal:true; their ids and index spaces) and `valid`
// (+ `reason`) per shape.
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
  const bool diagnose = q.boolean("diagnose", true);
  std::string bboxMode = q.str("bbox_mode", "fast");  // AddOptimal costs ~87 s on the 113 MB part natively

  std::vector<ImportItem> items;
  JV unit;
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
    unit = fileUnit(reader.ChangeReader());
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
    unit = fileUnit(reader);
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

  int fixedCount = 0;
  if (heal) {
    for (auto& it : items) {
      Handle(ShapeFix_Shape) sf = new ShapeFix_Shape(it.shape);
      sf->SetPrecision(tol);
      sf->SetMaxTolerance(tol);
      sf->Perform();
      if (sf->Status(ShapeExtend_DONE)) ++fixedCount;
      TopoDS_Shape fixed = sf->Shape();
      if (!fixed.IsNull()) it.shape = unwrap(fixed);
    }
  }
  double t3 = nowMs();

  JV shapes = JV::arr();
  std::vector<int> ids;
  int nf = 0, ne = 0;
  BRep_Builder bb;
  TopoDS_Compound all;
  bb.MakeCompound(all);
  for (auto& it : items) {
    int id = putShape(it.shape);
    ids.push_back(id);
    Entry& en = entryOf(id);
    en.name = it.name;
    en.hasColor = it.hasColor;
    en.color = it.color;
    Indexed& ix = indexOf(id);
    nf += ix.f.Extent();
    ne += ix.e.Extent();
    bb.Add(all, it.shape);
  }
  double t4 = nowMs();
  std::vector<Diag> diags;
  if (diagnose)
    for (int id : ids) diags.push_back(diagnoseShape(shapeOf(id)));
  double t5 = nowMs();
  for (size_t k = 0; k < items.size(); ++k) {
    const ImportItem& it = items[k];
    JV s = JV::obj();
    s.set("id", ids[k]);
    s.set("name", it.name);
    s.set("color", it.hasColor ? colorJson(it.color) : JV());
    s.set("color_linear", it.hasColor ? colorJsonLinear(it.color) : JV());
    s.set("type", bodyType(it.shape));
    s.set("faces", indexOf(ids[k]).f.Extent());
    if (diagnose) {
      s.set("valid", diags[k].v.valid);
      if (!diags[k].v.valid) s.set("reason", diags[k].v.reason);
    }
    shapes.push(std::move(s));
  }
  JV r = JV::obj();
  r.set("shapes", std::move(shapes));
  r.set("faces", nf);
  r.set("edges", ne);
  r.set("unit", unit);
  if (heal) r.set("fixed", fixedCount);
  if (diagnose) r.set("diagnostics", diagnosticsJson(ids, diags));
  double t6 = nowMs();
  r.set("bbox", bboxJson(all, bboxMode));
  double t7 = nowMs();
  JV tm = JV::obj();
  tm.set("read_ms", t1 - t0);
  tm.set("transfer_ms", t2 - t1);
  tm.set("heal_ms", t3 - t2);
  tm.set("index_ms", t4 - t3);
  tm.set("diagnose_ms", t5 - t4);
  tm.set("bbox_ms", t7 - t6);
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

// ================================================================== API 3 ===
// docs/p2p3-plan.md §2 (the typed contract: src/types/kernel-protocol.ts): heal,
// brep_write / brep_read, press_pull, combine, measure, sketch_regions,
// extrude_regions. import_step's diagnostics and unit are in the STEP section.

// STEP name and colour of one stored shape, given to another (heal outputs).
void copyMeta(int from, int to) {
  const Entry& a = entryOf(from);
  Entry& b = entryOf(to);
  b.name = a.name;
  b.hasColor = a.hasColor;
  b.color = a.color;
}

void putMeta(JV& s, int id) {
  const Entry& en = entryOf(id);
  s.set("name", en.name);
  s.set("color", en.hasColor ? colorJson(en.color) : JV());
}

// ------------------------------------------------------------------- heal ---

// Heal shapes on work copies (the inputs never change):
// 1. ShapeFix_Shape on each input, precision and maximum tolerance `tol`.
// 2. Unless sew is false: every face that is not in a valid closed solid, over all
//    inputs together (a surface model often comes as one shell per face), goes
//    through BRepBuilderAPI_Sewing at `sew_tol` (default tol), and every closed shell
//    it gives becomes a solid (ShapeFix_Solid) = knit. sew: true and "auto" (the
//    default) are the same: only faces outside valid closed solids are sewn, so a
//    model of valid solids is never touched by sewing.
// Outputs: with sewing, every valid closed solid as it was, every knitted solid, and
// per input the faces left open as one surface body; without, one output per input.
// Ordered by the first input each came from. Each reports `from` (that input), its
// STEP name and colour, type, faces, `valid` (+ reason) and `history` (its faces ->
// input faces). `fixed`: inputs ShapeFix changed; `sewn`: faces that went through
// sewing; `free_edges`: open edges left on all outputs; `deleted`: input faces in no
// output; `diagnostics` (diagnose, default true) of the outputs.
JV opHeal(const JV& q) {
  std::vector<int> ids = idList(q, "ids", true);
  if (ids.empty()) throw InputError("heal needs at least one shape");
  {
    std::set<int> seen;
    for (int id : ids)
      if (!seen.insert(id).second) throw InputError("shape " + std::to_string(id) + " is given twice");
  }
  const double tol = q.num("tol", 1e-3);
  if (!(tol > 0)) throw InputError("tol must be > 0");
  bool sewOn = true;
  if (const JV* s = q.get("sew")) {
    if (s->isBool()) sewOn = s->boolean();
    else if (s->isStr() && s->str() == "auto") sewOn = true;
    else if (!s->isNull()) throw InputError("sew must be true, false or \"auto\"");
  }
  const double sewTol = q.num("sew_tol", tol);
  if (!(sewTol > 0)) throw InputError("sew_tol must be > 0");
  const bool diagnose = q.boolean("diagnose", true);
  const bool check = q.boolean("check", true);

  WorkCopies wc(ids);
  const size_t n = ids.size();
  const double t0 = nowMs();
  std::vector<TopoDS_Shape> fixedShape(n);
  std::vector<Handle(BRepTools_History)> hist(n);
  int fixedCount = 0;
  for (size_t k = 0; k < n; ++k) {
    Handle(ShapeFix_Shape) sf = new ShapeFix_Shape(wc.shape(k));
    sf->SetPrecision(tol);
    sf->SetMaxTolerance(tol);
    sf->Perform();
    if (sf->Status(ShapeExtend_DONE)) ++fixedCount;
    TopoDS_Shape s = sf->Shape();
    fixedShape[k] = s.IsNull() ? wc.shape(k) : unwrap(s);
    hist[k] = new BRepTools_History();
    Handle(BRepTools_History) fh = sf->Context()->History();
    if (!fh.IsNull()) hist[k]->Merge(fh);
  }
  const double t1 = nowMs();

  struct Out {
    TopoDS_Shape shape;
    size_t from;
    int order;  // solids first, then the open surface body
    bool known = false;
    Diag diag;  // when known: the analysis already made (a kept solid)
  };
  std::vector<Out> outs;
  int sewnFaces = 0;
  double checkMs = 0;
  std::unique_ptr<BRepBuilderAPI_Sewing> sew;
  if (!sewOn) {
    for (size_t k = 0; k < n; ++k) outs.push_back({fixedShape[k], k, 0});
  } else {
    std::vector<std::vector<TopoDS_Shape>> toSew(n);
    for (size_t k = 0; k < n; ++k) {
      for (TopExp_Explorer ex(fixedShape[k], TopAbs_SOLID); ex.More(); ex.Next()) {
        Diag d = diagnoseShape(ex.Current());
        checkMs += d.ms;
        if (d.v.valid && d.closed) {
          Out o{ex.Current(), k, 0};
          o.known = true;
          o.diag = d;
          outs.push_back(o);
        } else {
          for (TopExp_Explorer f(ex.Current(), TopAbs_FACE); f.More(); f.Next()) toSew[k].push_back(f.Current());
        }
      }
      for (TopExp_Explorer f(fixedShape[k], TopAbs_FACE, TopAbs_SOLID); f.More(); f.Next()) toSew[k].push_back(f.Current());
    }
    for (auto& v : toSew) sewnFaces += (int)v.size();
    if (sewnFaces) {
      sew.reset(new BRepBuilderAPI_Sewing(sewTol, Standard_True, Standard_True, Standard_True, Standard_False));
      for (auto& v : toSew)
        for (auto& f : v) sew->Add(f);
      sew->Perform();
      TopoDS_Shape sewed = sew->SewedShape();
      // Which input each sewn face came from (the first one, for shared results).
      TopTools_IndexedMapOfShape sewnMap;
      std::vector<size_t> sewnFrom;
      for (size_t k = 0; k < n; ++k)
        for (auto& f : toSew[k]) {
          TopoDS_Shape m = sew->IsModified(f) ? sew->Modified(f) : f;
          for (TopExp_Explorer ex(m, TopAbs_FACE); ex.More(); ex.Next())
            if (sewnMap.FindIndex(ex.Current()) == 0) {
              sewnMap.Add(ex.Current());
              sewnFrom.push_back(k);
            }
        }
      auto fromOf = [&](const TopoDS_Shape& s) {
        size_t best = n;
        for (TopExp_Explorer ex(s, TopAbs_FACE); ex.More(); ex.Next()) {
          int i = sewnMap.FindIndex(ex.Current());
          if (i) best = std::min(best, sewnFrom[i - 1]);
        }
        return best == n ? (size_t)0 : best;
      };
      std::vector<std::vector<TopoDS_Shape>> open(n);
      for (TopExp_Explorer ex(sewed, TopAbs_SHELL); ex.More(); ex.Next()) {
        TopoDS_Shell sh = TopoDS::Shell(ex.Current());
        const size_t from = fromOf(sh);
        if (freeEdgeCount(sh) == 0) {
          ShapeFix_Solid sfs;
          TopoDS_Solid so = sfs.SolidFromShell(sh);
          if (!so.IsNull()) {
            outs.push_back({so, from, 0});
            continue;
          }
        }
        open[from].push_back(sh);
      }
      for (TopExp_Explorer ex(sewed, TopAbs_FACE, TopAbs_SHELL); ex.More(); ex.Next()) open[fromOf(ex.Current())].push_back(ex.Current());
      for (size_t k = 0; k < n; ++k) {
        if (open[k].empty()) continue;
        if (open[k].size() == 1 && open[k][0].ShapeType() == TopAbs_SHELL) {
          outs.push_back({open[k][0], k, 1});
          continue;
        }
        BRep_Builder bb;
        TopoDS_Compound c;
        bb.MakeCompound(c);
        for (auto& s : open[k]) bb.Add(c, s);
        outs.push_back({c, k, 1});
      }
    }
  }
  std::stable_sort(outs.begin(), outs.end(), [](const Out& a, const Out& b) {
    return a.from != b.from ? a.from < b.from : a.order < b.order;
  });
  const double t2 = nowMs();

  // Sewing's face replacements, as a history after ShapeFix's.
  if (sew) {
    for (size_t k = 0; k < n; ++k) {
      Handle(BRepTools_History) sh = new BRepTools_History();
      bool any = false;
      for (TopExp_Explorer ex(fixedShape[k], TopAbs_FACE); ex.More(); ex.Next()) {
        const TopoDS_Shape& f = ex.Current();
        if (!sew->IsModified(f)) continue;
        for (TopExp_Explorer m(sew->Modified(f), TopAbs_FACE); m.More(); m.Next()) {
          if (m.Current().IsSame(f)) continue;
          sh->AddModified(f, m.Current());
          any = true;
        }
      }
      if (any) hist[k]->Merge(sh);
    }
  }

  JV shapes = JV::arr();
  std::vector<int> outIds;
  std::vector<Diag> diags;
  std::set<std::pair<size_t, int>> landed;
  int freeEdges = 0;
  for (auto& o : outs) {
    const int id = putShape(o.shape);
    outIds.push_back(id);
    copyMeta(ids[o.from], id);
    Indexed& out = indexOf(id);
    JV s = JV::obj();
    s.set("id", id);
    s.set("from", ids[o.from]);
    putMeta(s, id);
    s.set("type", bodyType(o.shape));
    s.set("faces", out.f.Extent());
    if (check || diagnose) {
      if (!o.known) {
        o.diag = diagnoseShape(o.shape);
        checkMs += o.diag.ms;
      }
      freeEdges += o.diag.freeEdges;
      diags.push_back(o.diag);
    } else {
      freeEdges += freeEdgeCount(o.shape);
    }
    if (check) {
      s.set("valid", o.diag.v.valid);
      if (!o.diag.v.valid) s.set("reason", o.diag.v.reason);
    } else {
      s.set("checked", false);
    }
    // History of this output: its faces -> input faces (other outputs' faces are
    // not "deleted" from it; `deleted` below lists input faces in no output).
    HistBuilder hb;
    for (size_t k = 0; k < n; ++k) hb.addInput(wc.id(k), *hist[k], out, ids[k]);
    for (auto& kv : hb.faceFrom)
      for (auto& src : kv.second.items())
        if (const JV* f = src.get("face")) {
          for (size_t k = 0; k < n; ++k)
            if ((int)src.get("shape")->num() == ids[k]) landed.insert({k, (int)f->num()});
        }
    hb.deleted = JV::arr();
    s.set("history", hb.json());
    shapes.push(std::move(s));
  }
  JV deleted = JV::arr();
  for (size_t k = 0; k < n; ++k) {
    const int nf = indexOf(ids[k]).f.Extent();
    for (int i = 0; i < nf; ++i)
      if (!landed.count({k, i})) {
        JV d = JV::obj();
        d.set("shape", ids[k]);
        d.set("face", i);
        deleted.push(std::move(d));
      }
  }
  JV r = JV::obj();
  r.set("shapes", std::move(shapes));
  r.set("fixed", fixedCount);
  r.set("sewn", sewnFaces);
  r.set("free_edges", freeEdges);
  r.set("deleted", std::move(deleted));
  if (diagnose) r.set("diagnostics", diagnosticsJson(outIds, diags));
  JV tm = JV::obj();
  tm.set("copy_ms", wc.ms);
  tm.set("fix_ms", t1 - t0);
  tm.set("sew_ms", t2 - t1);
  tm.set("check_ms", checkMs);
  r.set("timings", std::move(tm));
  return r;
}

// ------------------------------------------------------- brep_write / read ---

// A streambuf that appends to a malloc'd MBuf, so a big BREP is not held twice.
struct MBufOut : std::streambuf {
  MBuf<uint8_t>& b;
  explicit MBufOut(MBuf<uint8_t>& buf) : b(buf) {}
  int_type overflow(int_type c) override {
    if (c != traits_type::eof()) b.push((uint8_t)c);
    return traits_type::not_eof(c);
  }
  std::streamsize xsputn(const char* s, std::streamsize n) override {
    if (n <= 0) return 0;
    b.reserve(b.n + (size_t)n);
    memcpy(b.p + b.n, s, (size_t)n);
    b.n += (size_t)n;
    return n;
  }
  pos_type seekoff(off_type off, std::ios_base::seekdir dir, std::ios_base::openmode which) override {
    if (off == 0 && dir == std::ios_base::cur && (which & std::ios_base::out)) return pos_type((off_type)b.n);
    return pos_type(off_type(-1));
  }
};

// The shapes, in order, as one compound in OCCT's binary BREP format (BinTools,
// current format version, no triangulation). Buffer `brep`.
JV opBrepWrite(const JV& q) {
  std::vector<int> ids = idList(q, "ids", true);
  if (ids.empty()) throw InputError("brep_write needs at least one shape");
  const double t0 = nowMs();
  BRep_Builder bb;
  TopoDS_Compound all;
  bb.MakeCompound(all);
  for (int id : ids) bb.Add(all, shapeOf(id));
  MBuf<uint8_t> buf;
  {
    MBufOut sb(buf);
    std::ostream os(&sb);
    BinTools::Write(all, os, Standard_False, Standard_False, BinTools_FormatVersion_CURRENT);
    os.flush();
    if (!os) throw OcctError("writing the BREP failed");
  }
  const double t1 = nowMs();
  JV r = JV::obj();
  r.set("bytes", (double)buf.n);
  r.set("occt", OCC_VERSION_COMPLETE);
  JV tm = JV::obj();
  tm.set("write_ms", t1 - t0);
  r.set("timings", std::move(tm));
  JV bufs = JV::arr();
  bufs.push(buf.release("brep", "u8"));
  r.set("buffers", std::move(bufs));
  return r;
}

// Bytes (ptr/len) written by brep_write -> one stored shape per compound child, in
// order, with the face/edge/vertex indices they had (BinTools keeps the structure).
// No healing; check:true (default false) reports `valid` per shape.
JV opBrepRead(const JV& q) {
  const JV* jp = q.get("ptr");
  uintptr_t ptr = jp && jp->isNum() ? (uintptr_t)(uint64_t)jp->num() : 0;
  std::unique_ptr<char, void (*)(void*)> owner((char*)ptr, free);
  if (!ptr) throw InputError("null input pointer");
  const size_t len = (size_t)q.num("len");
  const bool check = q.boolean("check", false);
  const double t0 = nowMs();
  TopoDS_Shape all;
  {
    MemBuf mb(owner.get(), len);
    std::istream is(&mb);
    try {
      BinTools::Read(all, is);
    } catch (const Standard_OutOfMemory&) {
      throw;
    } catch (const Standard_Failure& e) {
      throw InputError("not a BREP written by brep_write (" + failureText(e) + ")");
    }
  }
  owner.reset();
  if (all.IsNull() || all.ShapeType() != TopAbs_COMPOUND) throw InputError("not a BREP written by brep_write");
  const double t1 = nowMs();
  JV shapes = JV::arr();
  double checkMs = 0;
  for (TopoDS_Iterator it(all); it.More(); it.Next()) {
    const int id = putShape(it.Value());
    JV s = JV::obj();
    s.set("id", id);
    s.set("type", bodyType(it.Value()));
    s.set("faces", indexOf(id).f.Extent());
    if (check) {
      Validity v = analyse(it.Value());
      checkMs += v.ms;
      s.set("valid", v.valid);
      if (!v.valid) s.set("reason", v.reason);
    }
    shapes.push(std::move(s));
  }
  if (shapes.size() == 0) throw InputError("the BREP holds no shapes");
  JV r = JV::obj();
  r.set("shapes", std::move(shapes));
  r.set("occt", OCC_VERSION_COMPLETE);
  JV tm = JV::obj();
  tm.set("read_ms", t1 - t0);
  tm.set("index_ms", nowMs() - t1 - checkMs);
  if (check) tm.set("check_ms", checkMs);
  r.set("timings", std::move(tm));
  return r;
}

// ------------------------------------------------------------- press_pull ---

// UnifySameDomain (faces and edges) after a boolean, with history, and checked:
// OCCT 7.9.3 can merge two coincident cylinders whose seams differ into an invalid
// face (the Vortex inlet pipe extended by press-pull: NotClosed + UnorientableShape,
// while the unmerged result is valid). When the merged result is invalid and the
// unmerged one is valid, the faces stay apart (`unified` false) instead of passing an
// invalid body on. UnifySameDomain can change its input in place (tolerances,
// pcurves), so it runs on a copy and the unmerged result stays as the boolean made it.
// Without check nothing is analysed and the merged result is kept.
struct Unified {
  TopoDS_Shape shape;
  Handle(BRepTools_History) hist;  // the op's input -> shape
  bool unified = false;
  bool checked = false;
  Validity v;
};

Unified unifyChecked(const TopoDS_Shape& raw, const Handle(BRepTools_History)& opHist, bool unify, bool check) {
  Unified u;
  u.shape = unwrap(raw);
  u.hist = opHist;
  if (unify && !raw.IsNull() && countOf(raw, TopAbs_FACE) > 0) {
    BRepBuilderAPI_Copy cp(raw, Standard_True, Standard_False);
    TopTools_ListOfShape rawList;
    rawList.Append(raw);
    ShapeUpgrade_UnifySameDomain usd(cp.Shape(), true, true, false);
    usd.Build();
    Handle(BRepTools_History) h = new BRepTools_History();
    h->Merge(opHist);
    h->Merge(new BRepTools_History(rawList, cp));
    h->Merge(usd.History());
    TopoDS_Shape m = unwrap(usd.Shape());
    if (check) {
      Validity vm = analyse(m);
      if (!vm.valid) {
        Validity vr = analyse(u.shape);
        if (vr.valid) {
          u.checked = true;
          u.v = vr;
          return u;
        }
      }
      u.checked = true;
      u.v = vm;
    }
    u.shape = m;
    u.hist = h;
    u.unified = true;
    return u;
  }
  if (check) {
    u.checked = true;
    u.v = analyse(u.shape);
  }
  return u;
}

// `faces` and the validity of a stored unifyChecked result.
void putChecked(JV& r, int id, const Unified& u) {
  r.set("faces", indexOf(id).f.Extent());
  if (u.checked) putValidity(r, u.v);
  else r.set("checked", false);
  r.set("unified", u.unified);
}


// The plane of a planar face and its outward normal (the face's orientation applied).
bool planarFace(const TopoDS_Face& F, gp_Pln& pl, gp_Dir& n) {
  BRepAdaptor_Surface as(F, false);
  if (as.GetType() != GeomAbs_Plane) return false;
  pl = as.Plane();
  n = pl.Axis().Direction();
  if (!pl.Direct()) n.Reverse();
  if (F.Orientation() == TopAbs_REVERSED) n.Reverse();
  return true;
}

std::string surfWords(const TopoDS_Face& F) {
  BRepAdaptor_Surface as(F, false);
  const std::string t = surfType(as.GetType());
  if (t == "bspline") return "a B-spline surface";
  if (t == "other") return "a curved surface";
  return "a " + t;
}

// The faces of `out` a face became through a history (its images, or itself).
std::vector<int> facesThrough(const BRepTools_History& h, const TopoDS_Shape& s, const Indexed& out) {
  std::vector<int> r;
  if (s.IsNull()) return r;
  const TopTools_ListOfShape& mods = h.Modified(s);
  for (TopTools_ListIteratorOfListOfShape it(mods); it.More(); it.Next())
    for (TopExp_Explorer ex(it.Value(), TopAbs_FACE); ex.More(); ex.Next()) {
      int k = out.f.FindIndex(ex.Current());
      if (k && std::find(r.begin(), r.end(), k - 1) == r.end()) r.push_back(k - 1);
    }
  if (r.empty() && !h.IsRemoved(s)) {
    int k = out.f.FindIndex(s);
    if (k) r.push_back(k - 1);
  }
  return r;
}

// Press-pull planar faces of one body (work copy): a prism of each face along its own
// outward normal by d (d > 0, fused) or into the body by |d| (d < 0, cut), all prisms
// in one boolean with the body (no glue: a prism can reach another wall of a
// non-convex body), then UnifySameDomain, history merged at every step. A face whose
// neighbours are perpendicular to it grows or shrinks exactly; a slanted neighbour is
// not extended (a step forms). `moved[i]`: the result face where faces[i] now lies
// (the prism's far cap; -1 if it is gone), reported `modified` from that input face
// in the history so it keeps its name. `sides["<face>:<edge>"]`: the result face swept
// from that input edge (history `generated` from the edge), absent where the side
// merged with a neighbour that already lay in its plane.
JV opPressPull(const JV& q) {
  const int sid = idParam(q.req("id"), "id");
  const JV& jf = q.req("faces");
  if (!jf.isArr() || jf.size() == 0) throw InputError("press_pull needs at least one face");
  const double d = q.num("d");
  if (!(fabs(d) > 1e-9)) throw InputError("press_pull distance must not be 0");
  const double fuzzy = q.num("fuzzy", 0);
  if (fuzzy < 0) throw InputError("fuzzy must be >= 0");
  const std::string glue = q.str("glue", "off");
  if (glue != "off" && glue != "shift") throw InputError("glue must be off or shift");
  const bool unifyOn = q.boolean("unify", true);
  std::vector<int> fidx;
  for (auto& f : jf.items()) {
    TopoDS_Face F = faceAt(sid, f);
    const int i = (int)f.num();
    if (std::find(fidx.begin(), fidx.end(), i) != fidx.end()) throw InputError("face " + std::to_string(i) + " is given twice");
    gp_Pln pl;
    gp_Dir nn;
    if (!planarFace(F, pl, nn)) throw InputError("press_pull needs planar faces: face " + std::to_string(i) + " is " + surfWords(F));
    fidx.push_back(i);
  }
  WorkCopies wc({sid});
  const int wid = wc.id(0);
  Indexed& in = indexOf(wid);
  const double t0 = nowMs();
  struct Prism {
    int face;
    TopoDS_Face src;
    std::shared_ptr<BRepBuilderAPI_Copy> cp;
    std::shared_ptr<BRepPrimAPI_MakePrism> mp;
  };
  std::vector<Prism> prisms;
  TopTools_ListOfShape tools;
  for (int i : fidx) {
    TopoDS_Face F = TopoDS::Face(in.f(i + 1));
    gp_Pln pl;
    gp_Dir nn;
    planarFace(F, pl, nn);
    auto cp = std::make_shared<BRepBuilderAPI_Copy>(F, Standard_True, Standard_False);
    gp_Vec v(nn.XYZ());
    v *= d;
    auto mp = std::make_shared<BRepPrimAPI_MakePrism>(cp->Shape(), v, Standard_False, Standard_True);
    mp->Build();
    if (!mp->IsDone()) throw OcctError("press-pull failed: no prism for face " + std::to_string(i) + "; the body is unchanged");
    tools.Append(mp->Shape());
    prisms.push_back({i, F, cp, mp});
  }
  std::unique_ptr<BRepAlgoAPI_BooleanOperation> bop;
  if (d > 0) bop.reset(new BRepAlgoAPI_Fuse());
  else bop.reset(new BRepAlgoAPI_Cut());
  TopTools_ListOfShape args;
  args.Append(wc.shape(0));
  bop->SetArguments(args);
  bop->SetTools(tools);
  bop->SetRunParallel(false);
  bop->SetNonDestructive(true);
  bop->SetToFillHistory(true);
  if (fuzzy > 0) bop->SetFuzzyValue(fuzzy);
  if (glue == "shift") bop->SetGlue(BOPAlgo_GlueShift);
  bop->Build();
  if (bop->HasErrors()) throw OcctError("press-pull failed: " + algoErrors(*bop) + "; the body is unchanged");
  const double t1 = nowMs();
  Handle(BRepTools_History) bh = new BRepTools_History();
  if (!bop->History().IsNull()) bh->Merge(bop->History());
  const Unified uni = unifyChecked(bop->Shape(), bh, unifyOn, q.boolean("check", true));
  const double t2 = nowMs();
  const TopoDS_Shape res = uni.shape;
  const Handle(BRepTools_History) hist = uni.hist;
  if (res.IsNull() || countOf(res, TopAbs_FACE) == 0) throw OcctError("press-pull would remove the whole body");
  const int id = putShape(res);
  Indexed& out = indexOf(id);

  HistBuilder hb;
  hb.addInput(wid, *hist, out, sid);
  // Result faces some face of the input body (other than a moved one) lies on.
  std::vector<bool> fromBody(out.f.Extent(), false);
  for (int i = 1; i <= in.f.Extent(); ++i) {
    if (std::find(fidx.begin(), fidx.end(), i - 1) != fidx.end()) continue;
    for (int k : facesThrough(*hist, in.f(i), out)) fromBody[k] = true;
  }
  JV moved = JV::arr();
  JV sides = JV::obj();
  std::set<int> movedFaces;
  for (auto& p : prisms) {
    std::vector<int> m = facesThrough(*hist, p.mp->LastShape(), out);
    const int mi = m.empty() ? -1 : m.front();
    moved.push(mi);
    if (mi >= 0) {
      hb.add(hb.faceFrom, mi, HistBuilder::from(sid, "face", p.face, "modified"));
      movedFaces.insert(p.face);
    }
    TopTools_IndexedMapOfShape edges;
    TopExp::MapShapes(p.src, TopAbs_EDGE, edges);
    for (int e = 1; e <= edges.Extent(); ++e) {
      const TopoDS_Shape& E = edges(e);
      const int ei = in.e.FindIndex(E) - 1;
      if (ei < 0 || BRep_Tool::Degenerated(TopoDS::Edge(E))) continue;
      TopoDS_Shape Ec;
      try {
        Ec = p.cp->ModifiedShape(E);
      } catch (const Standard_Failure&) {
        continue;
      }
      std::vector<int> side;
      const TopTools_ListOfShape& gens = p.mp->Generated(Ec);
      for (TopTools_ListIteratorOfListOfShape it(gens); it.More(); it.Next())
        for (int k : facesThrough(*hist, it.Value(), out))
          if (std::find(side.begin(), side.end(), k) == side.end()) side.push_back(k);
      if (side.empty() || fromBody[side.front()] || side.front() == mi) continue;
      sides.set(std::to_string(p.face) + ":" + std::to_string(ei), side.front());
      hb.add(hb.faceFrom, side.front(), HistBuilder::from(sid, "edge", ei, "generated"));
    }
  }
  // A moved face is not deleted: it lies where its prism's cap is.
  JV kept = JV::arr();
  for (auto& dj : hb.deleted.items()) {
    const JV* f = dj.get("face");
    if (f && movedFaces.count((int)f->num())) continue;
    kept.push(dj);
  }
  hb.deleted = kept;
  JV r = JV::obj();
  r.set("id", id);
  r.set("op", d > 0 ? "fuse" : "cut");
  r.set("empty", false);
  r.set("solids", countOf(res, TopAbs_SOLID));
  r.set("moved", std::move(moved));
  r.set("sides", std::move(sides));
  r.set("history", hb.json());
  putChecked(r, id, uni);
  JV tm = JV::obj();
  tm.set("copy_ms", wc.ms);
  tm.set("boolean_ms", t1 - t0);
  tm.set("unify_check_ms", t2 - t1);
  r.set("timings", std::move(tm));
  return r;
}

// ---------------------------------------------------------------- combine ---

// Join / Cut / Intersect with several targets and tools in one call, on work copies
// of every input (copied together, so shared sub-shapes stay shared). Join fuses
// every target and tool into one result (target = targets[0]); cut and intersect
// give one result per target: the target minus the tools, or the target in common
// with the union of the tools (several tools are fused first). Each result reports
// `empty` (nothing left), `solids`, `faces`, `valid` (+ reasons) and its history
// against the input ids. Whether tool bodies stay is the document's business: the
// inputs never change. UnifySameDomain with history unless unify:false.
JV opCombine(const JV& q) {
  const std::string op = q.str("op");
  if (op != "join" && op != "cut" && op != "intersect") throw InputError("combine op must be join, cut or intersect");
  std::vector<int> targets = idList(q, "targets", true);
  std::vector<int> tools = idList(q, "tools", false);
  if (targets.empty()) throw InputError("combine needs at least one target");
  if (op != "join" && tools.empty()) throw InputError("combine " + op + " needs at least one tool");
  if (op == "join" && targets.size() + tools.size() < 2) throw InputError("join needs at least two bodies");
  {
    std::set<int> seen;
    for (int id : targets)
      if (!seen.insert(id).second) throw InputError("body " + std::to_string(id) + " is given twice");
    for (int id : tools)
      if (!seen.insert(id).second) throw InputError("a body cannot be a target and a tool (" + std::to_string(id) + ")");
  }
  const double fuzzy = q.num("fuzzy", 0);
  if (fuzzy < 0) throw InputError("fuzzy must be >= 0");
  const bool unify = q.boolean("unify", true);
  const bool check = q.boolean("check", true);
  std::vector<int> inputs = targets;
  inputs.insert(inputs.end(), tools.begin(), tools.end());
  WorkCopies wc(inputs);
  const size_t nt = targets.size();
  double boolMs = 0, unifyMs = 0;
  auto setup = [&](BRepAlgoAPI_BooleanOperation& b, const TopTools_ListOfShape& A, const TopTools_ListOfShape& T) {
    b.SetArguments(A);
    b.SetTools(T);
    b.SetRunParallel(false);
    b.SetNonDestructive(true);
    b.SetToFillHistory(true);
    if (fuzzy > 0) b.SetFuzzyValue(fuzzy);
  };
  // One result: the boolean's shape and history -> unify -> stored, with JSON.
  auto finish = [&](BRepAlgoAPI_BooleanOperation& b, Handle(BRepTools_History) hist, int target,
                    const std::vector<std::pair<int, int>>& pairs) {
    if (!b.History().IsNull()) hist->Merge(b.History());
    const double u0 = nowMs();
    const Unified uni = unifyChecked(b.Shape(), hist, unify, check);
    unifyMs += nowMs() - u0;
    const TopoDS_Shape& res = uni.shape;
    const int id = putShape(res);
    JV o = JV::obj();
    o.set("target", target);
    o.set("id", id);
    o.set("empty", countOf(res, TopAbs_FACE) == 0);
    o.set("solids", countOf(res, TopAbs_SOLID));
    std::string w = algoWarnings(b);
    if (!w.empty()) o.set("warning_text", w);
    o.set("history", historyForPairs(pairs, *uni.hist, id));
    putChecked(o, id, uni);
    return o;
  };
  JV results = JV::arr();
  if (op == "join") {
    TopTools_ListOfShape A, T;
    if (!tools.empty()) {
      for (size_t k = 0; k < inputs.size(); ++k) (k < nt ? A : T).Append(wc.shape(k));
    } else {
      A.Append(wc.shape(0));
      for (size_t k = 1; k < inputs.size(); ++k) T.Append(wc.shape(k));
    }
    BRepAlgoAPI_Fuse f;
    setup(f, A, T);
    const double b0 = nowMs();
    f.Build();
    boolMs += nowMs() - b0;
    if (f.HasErrors()) throw OcctError("join failed: " + algoErrors(f) + "; the bodies are unchanged");
    results.push(finish(f, new BRepTools_History(), targets[0], wc.pairs()));
  } else {
    // The tools as one shape (intersect with several tools: their union).
    TopoDS_Shape toolShape;
    Handle(BRepTools_History) toolHist = new BRepTools_History();
    TopTools_ListOfShape toolList;
    if (op == "intersect" && tools.size() > 1) {
      TopTools_ListOfShape A, T;
      A.Append(wc.shape(nt));
      for (size_t k = nt + 1; k < inputs.size(); ++k) T.Append(wc.shape(k));
      BRepAlgoAPI_Fuse u;
      setup(u, A, T);
      const double b0 = nowMs();
      u.Build();
      boolMs += nowMs() - b0;
      if (u.HasErrors()) throw OcctError("intersect failed while joining the tools: " + algoErrors(u) + "; the bodies are unchanged");
      if (!u.History().IsNull()) toolHist->Merge(u.History());
      toolList.Append(u.Shape());
    } else {
      for (size_t k = nt; k < inputs.size(); ++k) toolList.Append(wc.shape(k));
    }
    for (size_t t = 0; t < nt; ++t) {
      TopTools_ListOfShape A;
      A.Append(wc.shape(t));
      std::unique_ptr<BRepAlgoAPI_BooleanOperation> b;
      if (op == "cut") b.reset(new BRepAlgoAPI_Cut());
      else b.reset(new BRepAlgoAPI_Common());
      setup(*b, A, toolList);
      const double b0 = nowMs();
      b->Build();
      boolMs += nowMs() - b0;
      if (b->HasErrors()) throw OcctError(op + " failed: " + algoErrors(*b) + "; the bodies are unchanged");
      Handle(BRepTools_History) hist = new BRepTools_History();
      hist->Merge(toolHist);
      std::vector<std::pair<int, int>> pairs{{wc.id(t), targets[t]}};
      for (size_t k = nt; k < inputs.size(); ++k) pairs.emplace_back(wc.id(k), inputs[k]);
      results.push(finish(*b, hist, targets[t], pairs));
    }
  }
  JV r = JV::obj();
  r.set("results", std::move(results));
  JV tm = JV::obj();
  tm.set("copy_ms", wc.ms);
  tm.set("boolean_ms", boolMs);
  tm.set("unify_check_ms", unifyMs);
  r.set("timings", std::move(tm));
  return r;
}

// ---------------------------------------------------------------- measure ---

// What `measure` knows about one target: its measures (MeasureOne JSON), finite
// geometry for distances (null for an origin plane or axis: infinite), a direction
// for angles (1 = plane normal, 2 = line direction) and a centre for centre
// distances (1 = a point: circle, arc, sphere; 2 = an axis: cylinder).
struct MTarget {
  JV one = JV::obj();
  TopoDS_Shape shape;
  bool infPlane = false, infAxis = false;
  gp_Pnt org;
  gp_Dir dir;
  int dirKind = 0;
  gp_Dir angDir;
  int centerKind = 0;
  gp_Pnt center;
  gp_Ax1 centerAxis;
};

TopoDS_Vertex vertexAt(int id, const JV& v) {
  Indexed& ix = indexOf(id);
  int i = (int)v.num();
  if (i < 0 || i >= ix.v.Extent()) throw InputError("vertex index " + std::to_string(i) + " out of range");
  return TopoDS::Vertex(ix.v(i + 1));
}

// `full`: a whole body also gets its volume, area and centroid (only when it is the
// one target: they take tens of seconds on a large part, and a distance needs none).
MTarget measureTarget(const JV& t, const std::string& which, bool full) {
  MTarget m;
  if (!t.isObj()) throw InputError(which + " must be an object");
  JV& o = m.one;
  if (t.has("point")) {
    gp_Pnt p = pnt(t.req("point"));
    m.shape = BRepBuilderAPI_MakeVertex(p).Vertex();
    o.set("kind", "point");
    o.set("point", p3(p));
    return m;
  }
  if (t.has("plane")) {
    const JV& pl = t.req("plane");
    m.infPlane = true;
    m.org = pnt(pl.req("origin"));
    m.dir = dir(pl.req("normal"));
    m.dirKind = 1;
    m.angDir = m.dir;
    o.set("kind", "plane");
    o.set("point", p3(m.org));
    o.set("dir", d3(m.dir));
    return m;
  }
  if (t.has("axis")) {
    const JV& ax = t.req("axis");
    m.infAxis = true;
    m.org = pnt(ax.req("origin"));
    m.dir = dir(ax.req("dir"));
    m.dirKind = 2;
    m.angDir = m.dir;
    o.set("kind", "axis");
    o.set("point", p3(m.org));
    o.set("dir", d3(m.dir));
    return m;
  }
  if (!t.has("id")) throw InputError(which + " needs id, point, plane or axis");
  const int id = idParam(t.req("id"), (which + ".id").c_str());
  if ((int)t.has("face") + (int)t.has("edge") + (int)t.has("vertex") > 1) throw InputError(which + ": give one of face, edge or vertex");
  if (t.has("face")) {
    TopoDS_Face F = faceAt(id, t.req("face"));
    m.shape = F;
    BRepAdaptor_Surface as(F, false);
    GProp_GProps g;
    BRepGProp::SurfaceProperties(F, g);
    o.set("kind", "face");
    o.set("type", surfType(as.GetType()));
    o.set("area", g.Mass());
    gp_Pnt c = g.Mass() > 0 ? g.CentreOfMass() : gp_Pnt();
    o.set("center", p3(c));
    switch (as.GetType()) {
      case GeomAbs_Plane: {
        gp_Pln pl;
        gp_Dir n;
        planarFace(F, pl, n);
        o.set("dir", d3(n));
        m.dirKind = 1;
        m.angDir = n;
        break;
      }
      case GeomAbs_Cylinder: {
        gp_Cylinder cy = as.Cylinder();
        o.set("radius", cy.Radius());
        o.set("dir", d3(cy.Axis().Direction()));
        m.dirKind = 2;
        m.angDir = cy.Axis().Direction();
        m.centerKind = 2;
        m.centerAxis = cy.Axis();
        break;
      }
      case GeomAbs_Cone: {
        gp_Cone co = as.Cone();
        o.set("radius", co.RefRadius());
        o.set("dir", d3(co.Axis().Direction()));
        m.dirKind = 2;
        m.angDir = co.Axis().Direction();
        break;
      }
      case GeomAbs_Sphere: {
        gp_Sphere sp = as.Sphere();
        o.set("radius", sp.Radius());
        o.set("center", p3(sp.Location()));
        m.centerKind = 1;
        m.center = sp.Location();
        break;
      }
      case GeomAbs_Torus: {
        gp_Torus to = as.Torus();
        o.set("radius", to.MajorRadius());
        o.set("dir", d3(to.Axis().Direction()));
        break;
      }
      default: break;
    }
    return m;
  }
  if (t.has("edge")) {
    TopoDS_Edge E = edgeAt(id, t.req("edge"));
    m.shape = E;
    o.set("kind", "edge");
    if (BRep_Tool::Degenerated(E)) {
      o.set("type", "degenerate");
      o.set("length", 0.0);
      return m;
    }
    BRepAdaptor_Curve c(E);
    const double f = c.FirstParameter(), l = c.LastParameter();
    o.set("type", curveType(c.GetType()));
    o.set("length", GCPnts_AbscissaPoint::Length(c));
    o.set("point", p3(c.Value(0.5 * (f + l))));
    if (c.GetType() == GeomAbs_Line) {
      gp_Dir d = c.Line().Direction();
      if (E.Orientation() == TopAbs_REVERSED) d.Reverse();
      o.set("dir", d3(d));
      m.dirKind = 2;
      m.angDir = d;
    } else if (c.GetType() == GeomAbs_Circle) {
      gp_Circ ci = c.Circle();
      o.set("radius", ci.Radius());
      o.set("center", p3(ci.Location()));
      o.set("dir", d3(ci.Axis().Direction()));
      m.centerKind = 1;
      m.center = ci.Location();
    }
    return m;
  }
  if (t.has("vertex")) {
    TopoDS_Vertex V = vertexAt(id, t.req("vertex"));
    m.shape = V;
    o.set("kind", "vertex");
    o.set("point", p3(BRep_Tool::Pnt(V)));
    return m;
  }
  const TopoDS_Shape& s = shapeOf(id);
  m.shape = s;
  o.set("kind", "body");
  if (!full) return m;
  GProp_GProps vp;
  BRepGProp::VolumeProperties(s, vp);
  o.set("volume", vp.Mass());
  if (vp.Mass() != 0) o.set("center", p3(vp.CentreOfMass()));
  GProp_GProps sp;
  BRepGProp::SurfaceProperties(s, sp);
  o.set("area", sp.Mass());
  return m;
}

// A finite stand-in for an origin plane or axis, big enough around `other`.
TopoDS_Shape boundedStandIn(const MTarget& m, const TopoDS_Shape& other) {
  Bnd_Box b;
  BRepBndLib::Add(other, b, false);
  double R = 1;
  if (!b.IsVoid()) {
    double x0, y0, z0, x1, y1, z1;
    b.Get(x0, y0, z0, x1, y1, z1);
    for (double x : {x0, x1})
      for (double y : {y0, y1})
        for (double z : {z0, z1}) R = std::max(R, m.org.Distance(gp_Pnt(x, y, z)));
  }
  R = 2 * R + 1;
  if (m.infPlane) return BRepBuilderAPI_MakeFace(gp_Pln(m.org, m.dir), -R, R, -R, R).Face();
  return BRepBuilderAPI_MakeEdge(gp_Lin(m.org, m.dir), -R, R).Edge();
}

// Closest points of two lines (parallel lines: the foot from a's origin).
void closestOnLines(const gp_Pnt& p, const gp_Dir& u, const gp_Pnt& q, const gp_Dir& v, gp_Pnt& a, gp_Pnt& b) {
  gp_Vec w(q, p);
  const double uv = gp_Vec(u.XYZ()).Dot(gp_Vec(v.XYZ()));
  const double den = 1 - uv * uv;
  const double d1 = gp_Vec(u.XYZ()).Dot(w), d2 = gp_Vec(v.XYZ()).Dot(w);
  double s = 0, t;
  if (den < 1e-12) {
    t = d2;  // parallel: a = p, b = foot of p on line (q, v)
  } else {
    s = (uv * d2 - d1) / den;
    t = (d2 - uv * d1) / den;
  }
  a = p.Translated(gp_Vec(u.XYZ()) * s);
  b = q.Translated(gp_Vec(v.XYZ()) * t);
}

// Measure one entity, or two (minimum distance, where it is reached and the delta;
// the angle between planes / lines / axes; the distance between centres). One target
// gives its own measures: a face's type, area, centroid and normal or axis (radius for
// cylinders, cones, spheres); an edge's type, length, midpoint and direction (circle:
// radius, centre, axis); a vertex's point; a whole body's volume, area and centroid
// (alone; with a second target a body is only its geometry); an origin plane or axis.
JV opMeasure(const JV& q) {
  const double t0 = nowMs();
  const bool two = q.has("b");
  MTarget a = measureTarget(q.req("a"), "a", !two);
  JV r = JV::obj();
  r.set("a", a.one);
  if (!two) {
    JV tm = JV::obj();
    tm.set("measure_ms", nowMs() - t0);
    r.set("timings", std::move(tm));
    return r;
  }
  MTarget b = measureTarget(q.req("b"), "b", false);
  r.set("b", b.one);
  gp_Pnt p1, p2;
  double dist = 0;
  const bool aInf = a.infPlane || a.infAxis, bInf = b.infPlane || b.infAxis;
  if (aInf && bInf) {
    if (a.infPlane && b.infPlane) {
      if (a.dir.IsParallel(b.dir, 1e-9)) {
        p1 = a.org;
        const double s = gp_Vec(b.org, a.org).Dot(gp_Vec(b.dir.XYZ()));
        p2 = a.org.Translated(gp_Vec(b.dir.XYZ()) * -s);
      } else {
        // A point on both planes (on their line of intersection).
        gp_Vec n1(a.dir.XYZ()), n2(b.dir.XYZ());
        gp_Vec u = n1.Crossed(n2);
        const double h1 = n1.Dot(gp_Vec(a.org.XYZ())), h2 = n2.Dot(gp_Vec(b.org.XYZ()));
        gp_Vec x = (n2.Crossed(u) * h1 + u.Crossed(n1) * h2) / u.SquareMagnitude();
        p1 = p2 = gp_Pnt(x.XYZ());
      }
    } else if (a.infAxis && b.infAxis) {
      closestOnLines(a.org, a.dir, b.org, b.dir, p1, p2);
    } else {
      const MTarget& pl = a.infPlane ? a : b;
      const MTarget& ax = a.infPlane ? b : a;
      gp_Pnt onPlane, onAxis;
      const double dn = gp_Vec(ax.dir.XYZ()).Dot(gp_Vec(pl.dir.XYZ()));
      if (fabs(dn) < 1e-12) {
        onAxis = ax.org;
        const double s = gp_Vec(pl.org, ax.org).Dot(gp_Vec(pl.dir.XYZ()));
        onPlane = ax.org.Translated(gp_Vec(pl.dir.XYZ()) * -s);
      } else {
        const double t = gp_Vec(ax.org, pl.org).Dot(gp_Vec(pl.dir.XYZ())) / dn;
        onAxis = onPlane = ax.org.Translated(gp_Vec(ax.dir.XYZ()) * t);
      }
      p1 = a.infPlane ? onPlane : onAxis;
      p2 = a.infPlane ? onAxis : onPlane;
    }
    dist = p1.Distance(p2);
  } else {
    TopoDS_Shape sa = aInf ? boundedStandIn(a, b.shape) : a.shape;
    TopoDS_Shape sb = bInf ? boundedStandIn(b, a.shape) : b.shape;
    BRepExtrema_DistShapeShape dss(sa, sb);
    if (!dss.IsDone() || dss.NbSolution() < 1) throw OcctError("measure failed: no minimum distance was found");
    dist = dss.Value();
    p1 = dss.PointOnShape1(1);
    p2 = dss.PointOnShape2(1);
  }
  r.set("distance", dist);
  r.set("p1", p3(p1));
  r.set("p2", p3(p2));
  r.set("delta", vec3(p2.X() - p1.X(), p2.Y() - p1.Y(), p2.Z() - p1.Z()));
  if (a.dirKind && b.dirKind) {
    double ang = a.angDir.Angle(b.angDir);  // 0..pi
    if (ang > M_PI / 2) ang = M_PI - ang;    // lines and planes have no sense here
    if (a.dirKind != b.dirKind) ang = M_PI / 2 - ang;  // a line against a plane
    const double deg = ang / kDeg;
    r.set("angle_deg", deg);
    r.set("parallel", deg < 1e-7);
  }
  if (a.centerKind && b.centerKind) {
    double cd;
    if (a.centerKind == 1 && b.centerKind == 1) cd = a.center.Distance(b.center);
    else if (a.centerKind == 2 && b.centerKind == 2) {
      gp_Pnt x, y;
      closestOnLines(a.centerAxis.Location(), a.centerAxis.Direction(), b.centerAxis.Location(), b.centerAxis.Direction(), x, y);
      cd = x.Distance(y);
    } else {
      const gp_Ax1& ax = a.centerKind == 2 ? a.centerAxis : b.centerAxis;
      const gp_Pnt& c = a.centerKind == 1 ? a.center : b.center;
      cd = gp_Lin(ax).Distance(c);
    }
    r.set("center_distance", cd);
  }
  JV tm = JV::obj();
  tm.set("measure_ms", nowMs() - t0);
  r.set("timings", std::move(tm));
  return r;
}

// --------------------------------------------------------- sketch regions ---
// The closed regions of a sketch and their canonical keys (docs/p2p3-plan.md §2.8).
// Every non-construction curve becomes an edge on the sketch plane; a planar face
// covering them all (twice their box) is split by them (BRepAlgoAPI_Splitter, fuzzy =
// tol: edges are cut at every crossing, touch and overlap); the split faces that do
// not touch the covering face's own boundary are the regions.
//
// Region key grammar (nothing numeric, so a dimension change keeps the key):
// - split point: p:<point id> when a sketch point is there (pa/pb/pc of a curve, pid
//   of a point entity; the smallest id when several), else x:<E>|<F>#<k> for the
//   crossing of curves E < F (the two smallest ids when three or more meet) with a
//   pair-canonical ordinal k: line x line 0; line x arc/circle: 0 before the foot of
//   the circle's centre on the line (from a to b), 1 after it; arc/circle x
//   arc/circle: 0 left of the directed line centre(E) -> centre(F), 1 right; a
//   tangent touch 0. A curve end with no point id and no other curve: v:<E>#<0|1>.
//   Two split points that would get the same name (degenerate overlaps) get ~1, ~2...
//   in (u, v) order.
// - sub-segment: <E>[<from>><to>], along E's own direction (line a -> b, arc in its
//   sense, circle counter-clockwise about the normal); a whole circle with no split
//   point <E>[]; a circle touched once <E>[X>X]. OCCT splits a closed edge at its own
//   seam too; such seam vertices (one curve, two pieces, not the curve's end) are not
//   split points, so the pieces on either side are one sub-segment.
// - loop: signed tokens (+ along E's direction, - against it), region on the left
//   (outer counter-clockwise about the normal, holes clockwise), joined by one space,
//   rotated so the smallest token (byte order) is first.
// - key: the outer loop, then each hole loop sorted, joined by " / ".

const double kTwoPi = 2 * M_PI;

double wrapPi(double a) {
  a = fmod(a, kTwoPi);
  if (a <= -M_PI) a += kTwoPi;
  else if (a > M_PI) a -= kTwoPi;
  return a;
}

double wrap2Pi(double a) {
  a = fmod(a, kTwoPi);
  if (a < 0) a += kTwoPi;
  return a;
}

// A sketch plane: origin, normal (towards the viewer), xdir (made orthogonal).
gp_Ax3 sketchFrame(const JV& pl) {
  gp_Pnt o = pnt(pl.req("origin"));
  gp_Dir n = dir(pl.req("normal"));
  gp_Dir x = dir(pl.req("xdir"));
  gp_Vec xv(x.XYZ());
  xv -= gp_Vec(n.XYZ()) * xv.Dot(gp_Vec(n.XYZ()));
  if (xv.Magnitude() < 1e-9) throw InputError("plane xdir is parallel to its normal");
  return gp_Ax3(o, n, gp_Dir(xv));
}

struct SkCurve {
  std::string id, kind;          // line | arc | circle
  gp_Pnt2d a, b, c;              // line ends; arc/circle centre (an arc's ends in a, b)
  double r = 0, a0 = 0, a1 = 0;  // arcs: radians from xdir
  bool ccw = true;
  double sweep = 0;              // arcs: radians, > 0, in the arc's own sense
  double sense() const { return kind == "arc" && !ccw ? -1.0 : 1.0; }
};

struct SkSeg {
  int owner = -1;  // curve index
  std::vector<int> pieces;
  std::string token;
};

struct SkRegion {
  TopoDS_Face face;  // the region face, without internal (dangling) edges
  std::string key;
  std::vector<std::vector<std::string>> loops;
  std::vector<std::string> entities;
  double area = 0;
  gp_Pnt2d sample;
  double bb[4] = {0, 0, 0, 0};
};

struct SketchRegionSet {
  gp_Ax3 ax;
  double extent = 1, tol = 1e-7;
  std::vector<SkCurve> curves;
  std::vector<std::pair<std::string, gp_Pnt2d>> points;
  TopoDS_Shape split;
  TopTools_IndexedMapOfShape pieces;          // edges of `split` lying on sketch curves
  std::vector<std::vector<int>> pieceOwners;  // curve indices, ids ascending
  std::vector<bool> pieceForward;             // the edge's own direction runs along its owner's
  std::vector<int> pieceSeg;
  TopTools_IndexedMapOfShape verts;
  std::vector<std::string> vertName;
  std::vector<bool> vertReal;
  std::vector<int> vertDegree;
  std::vector<std::vector<int>> vertOwners;
  std::vector<SkSeg> segs;
  std::vector<SkRegion> regions;  // sorted by key
  JV open = JV::arr();
  std::vector<std::string> dangling;
  double buildMs = 0, splitMs = 0, keysMs = 0, meshMs = 0;

  gp_Pnt to3(const gp_Pnt2d& q) const {
    return gp_Pnt(ax.Location().XYZ() + ax.XDirection().XYZ() * q.X() + ax.YDirection().XYZ() * q.Y());
  }
  gp_Pnt2d to2(const gp_Pnt& p) const {
    gp_Vec v(ax.Location(), p);
    return gp_Pnt2d(v.Dot(gp_Vec(ax.XDirection().XYZ())), v.Dot(gp_Vec(ax.YDirection().XYZ())));
  }
};

double angleAt(const SkCurve& c, const gp_Pnt2d& p) { return atan2(p.Y() - c.c.Y(), p.X() - c.c.X()); }

double lineParam(const SkCurve& c, const gp_Pnt2d& p) {
  gp_Vec2d d(c.a, c.b);
  return gp_Vec2d(c.a, p).Dot(d) / d.SquareMagnitude();
}

bool onCurve(const SkCurve& c, const gp_Pnt2d& p, double eps) {
  if (c.kind == "line") {
    gp_Vec2d d(c.a, c.b);
    double t = std::min(1.0, std::max(0.0, lineParam(c, p)));
    gp_Pnt2d f(c.a.X() + d.X() * t, c.a.Y() + d.Y() * t);
    return f.Distance(p) <= eps;
  }
  if (fabs(p.Distance(c.c) - c.r) > eps) return false;
  if (c.kind == "circle") return true;
  const double s = wrap2Pi(c.sense() * (angleAt(c, p) - c.a0));
  const double ae = eps / c.r;
  return s <= c.sweep + ae || s >= kTwoPi - ae;
}

// 2D points along an edge (unoriented, its own parameter direction).
gp_Pnt2d edgePoint(const SketchRegionSet& R, const BRepAdaptor_Curve& c, double frac) {
  return R.to2(c.Value(c.FirstParameter() + frac * (c.LastParameter() - c.FirstParameter())));
}

// Pair-canonical ordinal of the crossing of curves E < F at p (see the grammar).
int crossingOrdinal(const SkCurve& E, const SkCurve& F, const gp_Pnt2d& p, double tol) {
  const bool el = E.kind == "line", fl = F.kind == "line";
  if (el && fl) return 0;
  if (el || fl) {
    const SkCurve& L = el ? E : F;
    const SkCurve& C = el ? F : E;
    const double len = L.a.Distance(L.b);
    const double tp = lineParam(L, p), tc = lineParam(L, C.c);
    const double e = tol / std::max(len, 1e-300);
    return tp < tc - e ? 0 : (tp > tc + e ? 1 : 0);
  }
  gp_Vec2d cc(E.c, F.c);
  const double m = cc.Magnitude();
  if (m <= tol) return 0;  // concentric: an overlap, named by its curve ends
  const double cr = cc.Crossed(gp_Vec2d(E.c, p));
  return cr > tol * m ? 0 : (cr < -tol * m ? 1 : 0);
}

std::unique_ptr<SketchRegionSet> computeRegions(const JV& q) {
  const double t0 = nowMs();
  std::unique_ptr<SketchRegionSet> R(new SketchRegionSet());
  R->ax = sketchFrame(q.req("plane"));
  const JV& jc = q.req("curves");
  if (!jc.isArr()) throw InputError("curves must be an array");
  std::set<std::string> ids;
  double extent = 1;
  for (auto& c : jc.items()) {
    const std::string id = c.str("id");
    const std::string kind = c.str("kind");
    if (!ids.insert(id).second) throw InputError("curve id '" + id + "' is given twice");
    if (kind == "point") {
      gp_Pnt2d p = uv(c.req("p"));
      const std::string pid = c.str("pid", "");
      if (!pid.empty()) R->points.emplace_back(pid, p);
      extent = std::max({extent, fabs(p.X()), fabs(p.Y())});
      continue;
    }
    SkCurve s;
    s.id = id;
    s.kind = kind;
    if (kind == "line") {
      s.a = uv(c.req("a"));
      s.b = uv(c.req("b"));
      extent = std::max({extent, fabs(s.a.X()), fabs(s.a.Y()), fabs(s.b.X()), fabs(s.b.Y())});
      const std::string pa = c.str("pa", ""), pb = c.str("pb", "");
      if (!pa.empty()) R->points.emplace_back(pa, s.a);
      if (!pb.empty()) R->points.emplace_back(pb, s.b);
    } else if (kind == "arc" || kind == "circle") {
      s.c = uv(c.req("c"));
      s.r = c.num("r");
      if (!(s.r > 0)) throw InputError(kind + " " + id + " needs a radius > 0");
      extent = std::max({extent, fabs(s.c.X()) + s.r, fabs(s.c.Y()) + s.r});
      const std::string pc = c.str("pc", "");
      if (!pc.empty()) R->points.emplace_back(pc, s.c);
      if (kind == "arc") {
        s.a0 = c.num("a0") * kDeg;
        s.a1 = c.num("a1") * kDeg;
        s.ccw = c.boolean("ccw", true);
        s.sweep = wrap2Pi(s.sense() * (s.a1 - s.a0));
        s.a = gp_Pnt2d(s.c.X() + s.r * cos(s.a0), s.c.Y() + s.r * sin(s.a0));
        s.b = gp_Pnt2d(s.c.X() + s.r * cos(s.a1), s.c.Y() + s.r * sin(s.a1));
        const std::string pa = c.str("pa", ""), pb = c.str("pb", "");
        if (!pa.empty()) R->points.emplace_back(pa, s.a);
        if (!pb.empty()) R->points.emplace_back(pb, s.b);
      }
    } else {
      throw InputError("unknown curve kind '" + kind + "' (" + id + ")");
    }
    R->curves.push_back(s);
  }
  R->extent = extent;
  R->tol = q.num("tol", 1e-7 * extent);
  if (!(R->tol > 0)) throw InputError("tol must be > 0");
  const double tol = R->tol;
  for (auto& s : R->curves) {
    if (s.kind == "line" && s.a.Distance(s.b) <= tol) throw InputError("line " + s.id + " has no length");
    if (s.kind != "line" && s.r <= tol) throw InputError(s.kind + " " + s.id + " has no length");
    if (s.kind == "arc" && (s.sweep * s.r <= tol || (kTwoPi - s.sweep) * s.r <= tol)) throw InputError("arc " + s.id + " has no length");
  }
  std::sort(R->curves.begin(), R->curves.end(), [](const SkCurve& a, const SkCurve& b) { return a.id < b.id; });
  if (R->curves.empty()) return R;

  // Edges on the plane, and the covering face.
  const gp_Dir N = R->ax.Direction(), X = R->ax.XDirection();
  TopTools_ListOfShape tools;
  double u0 = 1e300, v0 = 1e300, u1 = -1e300, v1 = -1e300;
  auto grow = [&](double u, double v) {
    u0 = std::min(u0, u);
    v0 = std::min(v0, v);
    u1 = std::max(u1, u);
    v1 = std::max(v1, v);
  };
  for (auto& s : R->curves) {
    TopoDS_Edge e;
    if (s.kind == "line") {
      BRepBuilderAPI_MakeEdge me(R->to3(s.a), R->to3(s.b));
      if (!me.IsDone()) throw InputError("line " + s.id + " cannot be built");
      e = me.Edge();
      grow(s.a.X(), s.a.Y());
      grow(s.b.X(), s.b.Y());
    } else {
      gp_Circ circ(gp_Ax2(R->to3(s.c), N, X), s.r);
      BRepBuilderAPI_MakeEdge me = s.kind == "circle" ? BRepBuilderAPI_MakeEdge(circ)
                                   : s.ccw            ? BRepBuilderAPI_MakeEdge(circ, s.a0, s.a0 + s.sweep)
                                                      : BRepBuilderAPI_MakeEdge(circ, s.a1, s.a1 + s.sweep);
      if (!me.IsDone()) throw InputError(s.kind + " " + s.id + " cannot be built");
      e = me.Edge();
      grow(s.c.X() - s.r, s.c.Y() - s.r);
      grow(s.c.X() + s.r, s.c.Y() + s.r);
    }
    tools.Append(e);
  }
  const double half = std::max(u1 - u0, v1 - v0) + 1.0;
  const double cu = 0.5 * (u0 + u1), cv = 0.5 * (v0 + v1);
  TopoDS_Face cover = BRepBuilderAPI_MakeFace(gp_Pln(R->ax), cu - half, cu + half, cv - half, cv + half).Face();
  const double t1 = nowMs();
  BRepAlgoAPI_Splitter sp;
  TopTools_ListOfShape args;
  args.Append(cover);
  sp.SetArguments(args);
  sp.SetTools(tools);
  sp.SetRunParallel(false);
  sp.SetNonDestructive(true);
  sp.SetToFillHistory(false);
  sp.SetFuzzyValue(tol);
  sp.Build();
  if (sp.HasErrors()) throw OcctError("finding the sketch regions failed: " + algoErrors(sp));
  R->split = sp.Shape();
  const double t2 = nowMs();

  // Pieces: edges of the split lying on sketch curves (owners by geometry, so overlaps
  // name every curve they lie on).
  {
    TopTools_IndexedMapOfShape all;
    TopExp::MapShapes(R->split, TopAbs_EDGE, all);
    for (int i = 1; i <= all.Extent(); ++i) {
      TopoDS_Edge e = TopoDS::Edge(all(i));
      if (BRep_Tool::Degenerated(e)) continue;
      e.Orientation(TopAbs_FORWARD);
      BRepAdaptor_Curve c(e);
      const gp_Pnt2d pA = edgePoint(*R, c, 0.3), pB = edgePoint(*R, c, 0.7);
      const double eps = 10 * tol + BRep_Tool::Tolerance(e);
      std::vector<int> owners;
      for (size_t k = 0; k < R->curves.size(); ++k)
        if (onCurve(R->curves[k], pA, eps) && onCurve(R->curves[k], pB, eps)) owners.push_back((int)k);
      if (owners.empty()) continue;
      R->pieces.Add(e);
      R->pieceOwners.push_back(owners);
      // Does the edge's own direction run along its first owner's direction?
      const SkCurve& E = R->curves[owners[0]];
      const gp_Pnt2d q0 = edgePoint(*R, c, 0.25), q1 = edgePoint(*R, c, 0.5);
      bool fwd;
      if (E.kind == "line") fwd = lineParam(E, q1) > lineParam(E, q0);
      else fwd = E.sense() * wrapPi(angleAt(E, q1) - angleAt(E, q0)) > 0;
      R->pieceForward.push_back(fwd);
    }
  }
  const int np = R->pieces.Extent();
  // Vertices: degree (pieces ending there), curves there, name, split point or seam.
  std::vector<std::pair<int, int>> pieceVerts(np);
  for (int p = 0; p < np; ++p) {
    TopoDS_Vertex a, b;
    TopExp::Vertices(TopoDS::Edge(R->pieces(p + 1)), a, b);
    const int ia = R->verts.FindIndex(a) ? R->verts.FindIndex(a) : R->verts.Add(a);
    const int ib = R->verts.FindIndex(b) ? R->verts.FindIndex(b) : R->verts.Add(b);
    pieceVerts[p] = {ia - 1, ib - 1};
  }
  const int nv = R->verts.Extent();
  R->vertDegree.assign(nv, 0);
  R->vertOwners.assign(nv, {});
  std::vector<std::vector<int>> vertPieces(nv);
  for (int p = 0; p < np; ++p) {
    for (int v : {pieceVerts[p].first, pieceVerts[p].second}) {
      ++R->vertDegree[v];
      vertPieces[v].push_back(p);
      for (int o : R->pieceOwners[p])
        if (std::find(R->vertOwners[v].begin(), R->vertOwners[v].end(), o) == R->vertOwners[v].end()) R->vertOwners[v].push_back(o);
    }
  }
  R->vertName.assign(nv, "");
  R->vertReal.assign(nv, false);
  std::vector<gp_Pnt2d> vuv(nv);
  for (int v = 0; v < nv; ++v) {
    const TopoDS_Vertex& V = TopoDS::Vertex(R->verts(v + 1));
    vuv[v] = R->to2(BRep_Tool::Pnt(V));
    auto& own = R->vertOwners[v];
    std::sort(own.begin(), own.end());  // curves are sorted by id: index order is id order
    const double ptol = 10 * tol + BRep_Tool::Tolerance(V);
    bool curveEnd = false;
    for (int o : own) {
      const SkCurve& c = R->curves[o];
      if (c.kind != "circle" && (c.a.Distance(vuv[v]) <= ptol || c.b.Distance(vuv[v]) <= ptol)) curveEnd = true;
    }
    R->vertReal[v] = R->vertDegree[v] != 2 || own.size() >= 2 || curveEnd;
    std::string best;
    for (auto& pt : R->points)
      if (pt.second.Distance(vuv[v]) <= ptol && (best.empty() || pt.first < best)) best = pt.first;
    if (!best.empty()) {
      R->vertName[v] = "p:" + best;
    } else if (own.size() >= 2) {
      const SkCurve& E = R->curves[own[0]];
      const SkCurve& F = R->curves[own[1]];
      R->vertName[v] = "x:" + E.id + "|" + F.id + "#" + std::to_string(crossingOrdinal(E, F, vuv[v], tol));
    } else if (!own.empty()) {
      const SkCurve& E = R->curves[own[0]];
      int k = 0;
      if (E.kind == "line") k = lineParam(E, vuv[v]) > 0.5 ? 1 : 0;
      else if (E.kind == "arc") k = E.b.Distance(vuv[v]) < E.a.Distance(vuv[v]) ? 1 : 0;
      R->vertName[v] = "v:" + E.id + "#" + std::to_string(k);
    }
  }
  {
    // Degenerate overlaps can give two split points one name: ~1, ~2 in (u, v) order.
    std::map<std::string, std::vector<int>> byName;
    for (int v = 0; v < nv; ++v)
      if (R->vertReal[v]) byName[R->vertName[v]].push_back(v);
    for (auto& kv : byName) {
      if (kv.second.size() < 2) continue;
      auto list = kv.second;
      std::sort(list.begin(), list.end(), [&](int a, int b) {
        return vuv[a].X() != vuv[b].X() ? vuv[a].X() < vuv[b].X() : vuv[a].Y() < vuv[b].Y();
      });
      for (size_t i = 1; i < list.size(); ++i) R->vertName[list[i]] += "~" + std::to_string(i);
    }
  }
  // Sub-segments: pieces of the same curves joined at seam vertices.
  std::vector<int> parent(np);
  for (int p = 0; p < np; ++p) parent[p] = p;
  std::function<int(int)> root = [&](int p) { return parent[p] == p ? p : parent[p] = root(parent[p]); };
  for (int v = 0; v < nv; ++v) {
    if (R->vertReal[v]) continue;
    auto& ps = vertPieces[v];
    for (size_t i = 1; i < ps.size(); ++i)
      if (R->pieceOwners[ps[i]] == R->pieceOwners[ps[0]]) parent[root(ps[i])] = root(ps[0]);
  }
  R->pieceSeg.assign(np, -1);
  {
    std::map<int, int> segOf;
    for (int p = 0; p < np; ++p) {
      const int rt = root(p);
      auto it = segOf.find(rt);
      if (it == segOf.end()) {
        it = segOf.emplace(rt, (int)R->segs.size()).first;
        R->segs.emplace_back();
        R->segs.back().owner = R->pieceOwners[p][0];
      }
      R->pieceSeg[p] = it->second;
      R->segs[it->second].pieces.push_back(p);
    }
  }
  for (auto& sg : R->segs) {
    const SkCurve& E = R->curves[sg.owner];
    std::map<int, int> count;
    for (int p : sg.pieces) {
      ++count[pieceVerts[p].first];
      ++count[pieceVerts[p].second];
    }
    std::vector<int> ends, reals;
    for (auto& kv : count) {
      if (kv.second % 2) ends.push_back(kv.first);
      if (R->vertReal[kv.first]) reals.push_back(kv.first);
    }
    if (ends.empty()) {
      sg.token = reals.empty() ? E.id + "[]" : E.id + "[" + R->vertName[reals[0]] + ">" + R->vertName[reals[0]] + "]";
      continue;
    }
    if (ends.size() != 2) throw OcctError("finding the sketch regions failed: curve " + E.id + " splits into an irregular chain");
    int A = ends[0], B = ends[1];
    bool ab;
    if (E.kind == "line") {
      ab = lineParam(E, vuv[A]) < lineParam(E, vuv[B]);
    } else {
      // Counter-clockwise (in E's sense) from A, a point inside the chain comes before B.
      BRepAdaptor_Curve c(TopoDS::Edge(R->pieces(sg.pieces[0] + 1)));
      const gp_Pnt2d m = edgePoint(*R, c, 0.5);
      const double s = E.sense();
      ab = wrap2Pi(s * (angleAt(E, m) - angleAt(E, vuv[A]))) < wrap2Pi(s * (angleAt(E, vuv[B]) - angleAt(E, vuv[A])));
    }
    if (!ab) std::swap(A, B);
    sg.token = E.id + "[" + R->vertName[A] + ">" + R->vertName[B] + "]";
  }
  // Open ends.
  for (int v = 0; v < nv; ++v) {
    if (R->vertDegree[v] != 1) continue;
    JV o = JV::obj();
    JV at = JV::arr();
    at.push(vuv[v].X());
    at.push(vuv[v].Y());
    o.set("at", std::move(at));
    o.set("entity", R->curves[R->pieceOwners[vertPieces[v][0]][0]].id);
    const std::string& nm = R->vertName[v];
    o.set("point", nm.rfind("p:", 0) == 0 ? JV(nm.substr(2)) : JV());
    R->open.push(std::move(o));
  }
  const double t3 = nowMs();

  // Regions: split faces bounded only by pieces.
  std::set<int> bounding;
  for (TopExp_Explorer fx(R->split, TopAbs_FACE); fx.More(); fx.Next()) {
    const TopoDS_Face& F = TopoDS::Face(fx.Current());
    bool inside = true;
    for (TopExp_Explorer ex(F, TopAbs_EDGE); ex.More() && inside; ex.Next()) {
      const TopAbs_Orientation o = ex.Current().Orientation();
      if (o == TopAbs_INTERNAL || o == TopAbs_EXTERNAL) continue;
      if (!R->pieces.FindIndex(ex.Current())) inside = false;
    }
    if (!inside) continue;
    SkRegion rg;
    // The face without its internal (dangling) edges, on the same surface.
    {
      BRep_Builder bb;
      TopLoc_Location loc;
      Handle(Geom_Surface) surf = BRep_Tool::Surface(F, loc);
      TopoDS_Face nf;
      bb.MakeFace(nf, surf, loc, BRep_Tool::Tolerance(F));
      for (TopoDS_Iterator wi(F); wi.More(); wi.Next()) {
        if (wi.Value().ShapeType() != TopAbs_WIRE) continue;
        TopoDS_Wire w;
        bb.MakeWire(w);
        int n = 0;
        for (TopoDS_Iterator ei(wi.Value()); ei.More(); ei.Next()) {
          const TopAbs_Orientation o = ei.Value().Orientation();
          if (o == TopAbs_INTERNAL || o == TopAbs_EXTERNAL) continue;
          bb.Add(w, ei.Value());
          ++n;
        }
        if (!n) continue;
        w.Closed(Standard_True);
        w.Orientation(wi.Value().Orientation());
        bb.Add(nf, w);
      }
      nf.Orientation(F.Orientation());
      rg.face = nf;
    }
    // Loops: outer wire first.
    TopoDS_Wire outer = BRepTools::OuterWire(rg.face);
    std::vector<TopoDS_Wire> wires;
    if (!outer.IsNull()) wires.push_back(outer);
    for (TopoDS_Iterator wi(rg.face); wi.More(); wi.Next())
      if (wi.Value().ShapeType() == TopAbs_WIRE && !wi.Value().IsSame(outer)) wires.push_back(TopoDS::Wire(wi.Value()));
    std::set<int> ents;
    bool first = true;
    bool bbInit = false;
    std::vector<std::string> holes;
    std::string outerKey;
    for (auto& w : wires) {
      std::vector<std::pair<int, bool>> steps;  // (segment, along its curve)
      std::vector<gp_Pnt2d> pts;
      for (BRepTools_WireExplorer we(w, rg.face); we.More(); we.Next()) {
        const TopoDS_Edge& e = we.Current();
        const int p = R->pieces.FindIndex(e) - 1;
        if (p < 0) throw OcctError("finding the sketch regions failed: a region edge lies on no curve");
        const bool fwdTraversal = we.Orientation() != TopAbs_REVERSED;
        const bool along = fwdTraversal == R->pieceForward[p];
        const int sg = R->pieceSeg[p];
        bounding.insert(sg);
        for (int o : R->pieceOwners[p]) ents.insert(o);
        if (steps.empty() || steps.back().first != sg || steps.back().second != along) steps.emplace_back(sg, along);
        TopoDS_Edge ef = e;
        ef.Orientation(TopAbs_FORWARD);
        BRepAdaptor_Curve c(ef);
        const int ns = c.GetType() == GeomAbs_Line ? 1 : 24;
        for (int k = 0; k < ns; ++k) {
          const double fr = (double)k / ns;
          pts.push_back(edgePoint(*R, c, fwdTraversal ? fr : 1 - fr));
        }
        // Exact box: ends, and a circle's extreme points inside the piece.
        auto add = [&](const gp_Pnt2d& p2) {
          if (!bbInit) {
            rg.bb[0] = rg.bb[2] = p2.X();
            rg.bb[1] = rg.bb[3] = p2.Y();
            bbInit = true;
          }
          rg.bb[0] = std::min(rg.bb[0], p2.X());
          rg.bb[1] = std::min(rg.bb[1], p2.Y());
          rg.bb[2] = std::max(rg.bb[2], p2.X());
          rg.bb[3] = std::max(rg.bb[3], p2.Y());
        };
        add(edgePoint(*R, c, 0));
        add(edgePoint(*R, c, 1));
        if (c.GetType() == GeomAbs_Circle) {
          const gp_Circ ci = c.Circle();
          const gp_Dir cx = ci.XAxis().Direction(), cy = ci.YAxis().Direction();
          const gp_Dir& U = R->ax.XDirection();
          const gp_Dir& V = R->ax.YDirection();
          const double f = c.FirstParameter(), l = c.LastParameter();
          for (double th0 : {atan2(cy.Dot(U), cx.Dot(U)), atan2(cy.Dot(V), cx.Dot(V))})
            for (double th : {th0, th0 + M_PI})
              for (int k = -2; k <= 2; ++k) {
                const double t = th + k * kTwoPi;
                if (t > f && t < l) add(R->to2(c.Value(t)));
              }
        }
      }
      if (steps.size() > 1 && steps.front() == steps.back()) steps.pop_back();
      double area2 = 0;
      for (size_t i = 0; i < pts.size(); ++i) {
        const gp_Pnt2d& a = pts[i];
        const gp_Pnt2d& b = pts[(i + 1) % pts.size()];
        area2 += a.X() * b.Y() - b.X() * a.Y();
      }
      const bool isOuter = first;
      first = false;
      if ((isOuter && area2 < 0) || (!isOuter && area2 > 0)) {
        std::reverse(steps.begin(), steps.end());
        for (auto& s : steps) s.second = !s.second;
      }
      std::vector<std::string> toks;
      for (auto& s : steps) toks.push_back((s.second ? "+" : "-") + R->segs[s.first].token);
      if (toks.empty()) continue;
      auto mn = std::min_element(toks.begin(), toks.end());
      std::rotate(toks.begin(), mn, toks.end());
      std::string joined;
      for (size_t i = 0; i < toks.size(); ++i) joined += (i ? " " : "") + toks[i];
      if (isOuter) outerKey = joined;
      else holes.push_back(joined);
      rg.loops.push_back(toks);
    }
    if (rg.loops.empty()) continue;
    // Holes in canonical (sorted) order, in the key and in `loops`.
    std::vector<std::vector<std::string>> holeLoops(rg.loops.begin() + 1, rg.loops.end());
    std::sort(holeLoops.begin(), holeLoops.end(), [](const std::vector<std::string>& a, const std::vector<std::string>& b) {
      std::string x, y;
      for (size_t i = 0; i < a.size(); ++i) x += (i ? " " : "") + a[i];
      for (size_t i = 0; i < b.size(); ++i) y += (i ? " " : "") + b[i];
      return x < y;
    });
    std::sort(holes.begin(), holes.end());
    rg.loops.resize(1);
    for (auto& h : holeLoops) rg.loops.push_back(h);
    rg.key = outerKey;
    for (auto& h : holes) rg.key += " / " + h;
    for (int o : ents) rg.entities.push_back(R->curves[o].id);
    std::sort(rg.entities.begin(), rg.entities.end());
    GProp_GProps g;
    BRepGProp::SurfaceProperties(rg.face, g);
    rg.area = g.Mass();
    rg.sample = R->to2(g.CentreOfMass());
    R->regions.push_back(rg);
  }
  std::sort(R->regions.begin(), R->regions.end(), [](const SkRegion& a, const SkRegion& b) { return a.key < b.key; });
  // Curves on no region's boundary.
  {
    std::set<std::string> used;
    for (auto& rg : R->regions)
      for (auto& e : rg.entities) used.insert(e);
    for (auto& c : R->curves)
      if (!used.count(c.id)) R->dangling.push_back(c.id);
  }
  const double t4 = nowMs();
  R->buildMs = t1 - t0;
  R->splitMs = t2 - t1;
  R->keysMs = t4 - t2;
  return R;
}

// The closed regions of a sketch: {regions: [{key, loops, entities, area, sample,
// bbox}], open, dangling} + buffers tri_uv (f32 u,v), tri_idx (u32), tri_ranges (u32
// per region: start in tri_idx, count) with tess (default true). Regions are sorted by
// key; `sample` is the centroid of the region's largest triangle (always inside), so
// the regions are meshed even without tess (deflection default 1e-3 x the extent).
JV opSketchRegions(const JV& q) {
  std::unique_ptr<SketchRegionSet> R = computeRegions(q);
  const bool tess = q.boolean("tess", true);
  const double defl = q.num("deflection", 1e-3 * R->extent);
  if (!(defl > 0)) throw InputError("deflection must be > 0");
  const double t0 = nowMs();
  MBuf<float> triUv;
  MBuf<uint32_t> triIdx, triRanges;
  JV regions = JV::arr();
  for (auto& rg : R->regions) {
    const uint32_t start = (uint32_t)triIdx.n;
    {
      // Meshed even without tess: the sample point is a triangle centroid.
      BRepMesh_IncrementalMesh m(rg.face, defl, Standard_False, 0.35, Standard_False);
      TopLoc_Location loc;
      Handle(Poly_Triangulation) tri = BRep_Tool::Triangulation(rg.face, loc);
      if (!tri.IsNull() && tri->NbTriangles() > 0) {
        const uint32_t base = (uint32_t)(triUv.n / 2);
        std::vector<gp_Pnt2d> nodes(tri->NbNodes() + 1);
        for (int k = 1; k <= tri->NbNodes(); ++k) {
          gp_Pnt p = tri->Node(k);
          if (!loc.IsIdentity()) p.Transform(loc.Transformation());
          nodes[k] = R->to2(p);
          triUv.push((float)nodes[k].X());
          triUv.push((float)nodes[k].Y());
        }
        double best = -1;
        for (int k = 1; k <= tri->NbTriangles(); ++k) {
          int a, b, c;
          tri->Triangle(k).Get(a, b, c);
          const double ar = 0.5 * gp_Vec2d(nodes[a], nodes[b]).Crossed(gp_Vec2d(nodes[a], nodes[c]));
          if (ar < 0) std::swap(b, c);
          triIdx.push(base + a - 1);
          triIdx.push(base + b - 1);
          triIdx.push(base + c - 1);
          if (fabs(ar) > best) {
            best = fabs(ar);
            rg.sample = gp_Pnt2d((nodes[a].X() + nodes[b].X() + nodes[c].X()) / 3, (nodes[a].Y() + nodes[b].Y() + nodes[c].Y()) / 3);
          }
        }
      }
    }
    triRanges.push(start);
    triRanges.push((uint32_t)triIdx.n - start);
    JV o = JV::obj();
    o.set("key", rg.key);
    JV loops = JV::arr();
    for (auto& l : rg.loops) {
      JV a = JV::arr();
      for (auto& t : l) a.push(t);
      loops.push(std::move(a));
    }
    o.set("loops", std::move(loops));
    JV ents = JV::arr();
    for (auto& e : rg.entities) ents.push(e);
    o.set("entities", std::move(ents));
    o.set("area", rg.area);
    JV s = JV::arr();
    s.push(rg.sample.X());
    s.push(rg.sample.Y());
    o.set("sample", std::move(s));
    JV bb = JV::arr();
    for (double v : rg.bb) bb.push(v);
    o.set("bbox", std::move(bb));
    regions.push(std::move(o));
  }
  const double t1 = nowMs();
  JV r = JV::obj();
  r.set("regions", std::move(regions));
  r.set("open", R->open);
  JV dang = JV::arr();
  for (auto& d : R->dangling) dang.push(d);
  r.set("dangling", std::move(dang));
  r.set("tol", R->tol);
  JV tm = JV::obj();
  tm.set("build_ms", R->buildMs);
  tm.set("split_ms", R->splitMs);
  tm.set("keys_ms", R->keysMs);
  tm.set("mesh_ms", t1 - t0);
  r.set("timings", std::move(tm));
  if (tess) {
    JV bufs = JV::arr();
    bufs.push(triUv.release("tri_uv", "f32"));
    bufs.push(triIdx.release("tri_idx", "u32"));
    bufs.push(triRanges.release("tri_ranges", "u32"));
    r.set("buffers", std::move(bufs));
  }
  return r;
}

// A profile moved along its plane's normal (copied geometry; edges mapped).
std::unique_ptr<Profile> shiftedProfile(const Profile& base, double shift) {
  std::unique_ptr<Profile> P(new Profile());
  P->ax = base.ax;
  if (fabs(shift) < 1e-300) {
    P->face = base.face;
    P->segEdges = base.segEdges;
    return P;
  }
  gp_Trsf t;
  t.SetTranslation(gp_Vec(base.ax.Direction().XYZ()) * shift);
  BRepBuilderAPI_Transform tf(base.face, t, Standard_True);
  if (!tf.IsDone()) throw OcctError("extrude failed (moving the profile)");
  P->face = TopoDS::Face(tf.Shape());
  for (auto& se : base.segEdges) P->segEdges.emplace_back(se.first, TopoDS::Edge(tf.ModifiedShape(se.second)));
  P->ax.Translate(gp_Vec(base.ax.Direction().XYZ()) * shift);
  return P;
}

// Extrude sketch regions by key. The regions are derived again from the curves (as
// sketch_regions) and a key that is not there is refused ("region not found: <key>").
// Selected regions that touch are merged into one face first (UnifySameDomain: faces
// on; edges merged only across a curve's own seam, so each side stays one
// sub-segment), then each face is swept as `extrude` does (same extents, flip, taper)
// and several are fused. History: `sides` per unsigned sub-segment token (faces
// entries `seg` = that token), `caps` per region key ({start, end}; merged regions
// share theirs), `start`/`end` = the first region's.
JV opExtrudeRegions(const JV& q) {
  const JV& ext = q.req("extent");
  const bool flip = q.boolean("flip", false);
  const double taper = q.num("taper_deg", 0);
  const bool tapered = fabs(taper) >= 1e-12;
  const JV& jk = q.req("regions");
  if (!jk.isArr() || jk.size() == 0) throw InputError("extrude_regions needs at least one region");
  std::unique_ptr<SketchRegionSet> R = computeRegions(q);
  std::map<std::string, int> byKey;
  for (size_t i = 0; i < R->regions.size(); ++i) byKey[R->regions[i].key] = (int)i;
  std::vector<int> sel;
  std::vector<std::string> selKeys;
  for (auto& k : jk.items()) {
    const std::string key = k.str();
    auto it = byKey.find(key);
    if (it == byKey.end()) throw InputError("region not found: " + key);
    if (std::find(sel.begin(), sel.end(), it->second) != sel.end()) continue;
    sel.push_back(it->second);
    selKeys.push_back(key);
  }
  // Merge touching regions; keep every split point (edges merge only at seams).
  TopoDS_Shell shell;
  BRep_Builder bb;
  bb.MakeShell(shell);
  for (int i : sel) bb.Add(shell, R->regions[i].face);
  ShapeUpgrade_UnifySameDomain u(shell, Standard_True, Standard_True, Standard_False);
  TopTools_MapOfShape keep;
  for (int v = 0; v < R->verts.Extent(); ++v)
    if (R->vertReal[v]) keep.Add(R->verts(v + 1));
  u.KeepShapes(keep);
  u.Build();
  const TopoDS_Shape merged = u.Shape();
  Handle(BRepTools_History) uh = u.History();
  // Each merged face, its region keys and its edges' tokens.
  TopTools_IndexedMapOfShape mfaces;
  TopExp::MapShapes(merged, TopAbs_FACE, mfaces);
  std::vector<std::vector<std::string>> keysOf(mfaces.Extent());
  std::vector<int> faceOfSel(sel.size(), -1);
  for (size_t s = 0; s < sel.size(); ++s) {
    const TopoDS_Face& f = R->regions[sel[s]].face;
    int k = 0;
    const TopTools_ListOfShape& mods = uh->Modified(f);
    for (TopTools_ListIteratorOfListOfShape it(mods); it.More() && !k; it.Next()) k = mfaces.FindIndex(it.Value());
    if (!k) k = mfaces.FindIndex(f);
    if (!k) throw OcctError("extrude failed: region " + selKeys[s] + " was lost while merging the profiles");
    faceOfSel[s] = k - 1;
    keysOf[k - 1].push_back(selKeys[s]);
  }
  TopTools_IndexedMapOfShape tokEdges;
  std::vector<std::string> tokOf;
  auto noteEdge = [&](const TopoDS_Shape& e, const std::string& tok) {
    if (!tokEdges.FindIndex(e)) {
      tokEdges.Add(e);
      tokOf.push_back(tok);
    }
  };
  for (int p = 0; p < R->pieces.Extent(); ++p) {
    const TopoDS_Shape& e = R->pieces(p + 1);
    const std::string& tok = R->segs[R->pieceSeg[p]].token;
    const TopTools_ListOfShape& mods = uh->Modified(e);
    for (TopTools_ListIteratorOfListOfShape it(mods); it.More(); it.Next()) noteEdge(it.Value(), tok);
    if (mods.IsEmpty() && !uh->IsRemoved(e)) noteEdge(e, tok);
  }
  std::vector<std::shared_ptr<Profile>> profiles;
  std::vector<TopoDS_Face> faces;
  for (int i = 1; i <= mfaces.Extent(); ++i) {
    auto P = std::make_shared<Profile>();
    P->ax = R->ax;
    P->face = TopoDS::Face(mfaces(i));
    TopTools_IndexedMapOfShape fe;
    TopExp::MapShapes(P->face, TopAbs_EDGE, fe);
    for (int k = 1; k <= fe.Extent(); ++k) {
      const int t = tokEdges.FindIndex(fe(k));
      if (!t) throw OcctError("extrude failed: a profile edge lies on no sketch curve");
      P->segEdges.emplace_back(tokOf[t - 1], TopoDS::Edge(fe(k)));
    }
    profiles.push_back(P);
    faces.push_back(P->face);
  }
  const gp_Dir n = R->ax.Direction();
  const gp_Dir de = flip ? n.Reversed() : n;
  const gp_Pnt o = R->ax.Location();
  const double sigma = flip ? -1.0 : 1.0;
  const ExtentPlan pl = planExtent(ext, o, de, tapered, faces);
  if (tapered && fabs(taper * kDeg) >= 0.5 * M_PI - 1e-6) throw InputError("taper must be between -90 and 90 degrees");
  std::vector<Sweep> sweeps;
  for (auto& P : profiles) {
    const Profile& base = *P;
    sweeps.push_back(sweepProfile([&](double shift) { return shiftedProfile(base, shift); }, pl, o, n, de, sigma, taper));
  }
  JV r = JV::obj();
  int id;
  std::vector<JV> hists;
  if (sweeps.size() == 1) {
    Sweep& sw = sweeps[0];
    id = putShape(sw.shape);
    hists.push_back(sweepHistory(id, *sw.prof, sw.generated, sw.first, sw.last));
  } else {
    TopTools_ListOfShape A, T;
    A.Append(sweeps[0].shape);
    for (size_t i = 1; i < sweeps.size(); ++i) T.Append(sweeps[i].shape);
    auto fu = std::make_shared<BRepAlgoAPI_Fuse>();
    fu->SetArguments(A);
    fu->SetTools(T);
    fu->SetRunParallel(false);
    fu->SetToFillHistory(true);
    fu->Build();
    if (fu->HasErrors()) throw OcctError("extrude failed while joining the profiles: " + algoErrors(*fu));
    id = putShape(unwrap(fu->Shape()));
    for (auto& sw : sweeps) {
      auto gen = sw.generated;
      hists.push_back(sweepHistory(
          id, *sw.prof, [&](const TopoDS_Shape& e) { return throughBoolean(*fu, gen(e)); },
          firstThroughBoolean(*fu, sw.first), firstThroughBoolean(*fu, sw.last)));
    }
  }
  JV hfaces = JV::arr();
  JV sides = JV::obj();
  JV caps = JV::obj();
  for (size_t i = 0; i < hists.size(); ++i) {
    for (auto& f : hists[i].get("faces")->items()) hfaces.push(f);
    for (auto& kv : hists[i].get("sides")->members()) sides.set(kv.first, kv.second);
    for (auto& key : keysOf[i]) {
      JV c = JV::obj();
      c.set("start", *hists[i].get("start"));
      c.set("end", *hists[i].get("end"));
      caps.set(key, std::move(c));
    }
  }
  JV hist = JV::obj();
  hist.set("faces", std::move(hfaces));
  hist.set("edges", JV::arr());
  hist.set("deleted", JV::arr());
  hist.set("sides", std::move(sides));
  hist.set("start", *hists[faceOfSel[0]].get("start"));
  hist.set("end", *hists[faceOfSel[0]].get("end"));
  hist.set("caps", std::move(caps));
  r.set("id", id);
  r.set("history", std::move(hist));
  addValidity(r, id, q);
  r.set("from", pl.s0);
  r.set("to", pl.s0 + pl.L);
  r.set("direction", d3(de));
  r.set("solids", countOf(shapeOf(id), TopAbs_SOLID));
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
  if (op == "heal") return opHeal(q);
  if (op == "brep_write") return opBrepWrite(q);
  if (op == "brep_read") return opBrepRead(q);
  if (op == "press_pull") return opPressPull(q);
  if (op == "combine") return opCombine(q);
  if (op == "measure") return opMeasure(q);
  if (op == "sketch_regions") return opSketchRegions(q);
  if (op == "extrude_regions") return opExtrudeRegions(q);
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
