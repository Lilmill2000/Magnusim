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
#include <BRepBuilderAPI_MakePolygon.hxx>
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
#include <BRepOffset_MakeOffset.hxx>
#include <BRepAlgoAPI_Check.hxx>
#include <BRepOffsetAPI_MakePipe.hxx>
#include <BRepOffsetAPI_MakePipeShell.hxx>
#include <BRepOffsetAPI_ThruSections.hxx>
#include <BRepFilletAPI_LocalOperation.hxx>
#include <GeomFill_Trihedron.hxx>

// P4b (API 5): B-spline sketch curves, copies, projection, section, silhouette.
#include <Geom2d_BSplineCurve.hxx>
#include <Geom2d_BezierCurve.hxx>
#include <Geom2d_Circle.hxx>
#include <Geom2d_Conic.hxx>
#include <Geom2d_Line.hxx>
#include <Geom2d_TrimmedCurve.hxx>
#include <Geom2dAdaptor_Curve.hxx>
#include <Geom2dAPI_PointsToBSpline.hxx>
#include <Geom2dAPI_Interpolate.hxx>
#include <TColgp_HArray1OfPnt2d.hxx>
#include <Geom2dAPI_ProjectPointOnCurve.hxx>
#include <Geom2dConvert.hxx>
#include <Geom2dConvert_ApproxCurve.hxx>
#include <Geom_BSplineCurve.hxx>
#include <Geom_Plane.hxx>
#include <Geom_TrimmedCurve.hxx>
#include <Geom_BezierCurve.hxx>
#include <Geom_RectangularTrimmedSurface.hxx>
#include <Geom_SweptSurface.hxx>
#include <GeomAPI.hxx>
#include <GeomProjLib.hxx>
#include <TColgp_Array1OfPnt.hxx>
#include <TColgp_Array1OfPnt2d.hxx>
#include <TColStd_Array1OfInteger.hxx>
#include <TColStd_Array1OfReal.hxx>
#include <TopTools_HSequenceOfShape.hxx>
#include <BRepAlgoAPI_Section.hxx>
#include <BRepLib.hxx>
#include <ShapeAnalysis_FreeBounds.hxx>
#include <HLRAlgo_Projector.hxx>
#include <HLRBRep_Algo.hxx>
#include <HLRBRep_HLRToShape.hxx>
#include <IntCurvesFace_ShapeIntersector.hxx>
#include <gp.hxx>

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
// combine, measure, sketch_regions, extrude_regions; 4 = P4a: revolve_regions,
// sweep_regions, loft_regions, extrude_face, edge_eval, extents to_vertex / to_point, fillet
// contours and diagnose, chamfer d2, shell outside, topo edge_ends / vertex_faces.
// 5 = P4b: B-spline sketch curves (R1), copies, project, section, silhouette.
// 6 = press-pull on curved faces: offset_faces (a true offset of picked faces, fillets
// re-rounded), press_pull takes curved faces (a thickened face as the tool).
const int kFacadeApi = 6;

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

// The exact span of `shapes` along `de`, as distances from `o` (no tolerance padding):
// the shapes moved into a frame whose Z is `de`, then their optimal box.
std::pair<double, double> spanAlong(const std::vector<TopoDS_Shape>& shapes, const gp_Pnt& o, const gp_Dir& de) {
  gp_Trsf t;
  t.SetTransformation(gp_Ax3(o, de));
  Bnd_Box b;
  for (auto& s : shapes) BRepBndLib::AddOptimal(s.Moved(TopLoc_Location(t)), b, Standard_False, Standard_False);
  if (b.IsVoid()) throw InputError("the target has no geometry");
  double x0, y0, z0, x1, y1, z1;
  b.Get(x0, y0, z0, x1, y1, z1);
  return {z0, z1};
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
//   {kind:"through_all", targets:[id], both?, fit?}  past everything in `targets` (both sides
//                             with both:true) by a margin (a Cut or an Intersect); with fit:true
//                             (a New body or a Join) exactly to the targets' farthest extent,
//                             and refused when the swept profile misses every target
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
    if (ext.boolean("fit", false)) {
      // A New body or a Join keeps what it makes: it ends exactly at the bodies' farthest
      // extent (no margin of made-up length), and a profile that misses them is refused.
      const auto span = spanAlong(targets, o, de);
      const double eps = std::max(1e-6, 1e-9 * c.front().Distance(c.back()));
      if (ext.boolean("both", false)) {
        s0 = std::min(span.first, 0.0);
        L = std::max(span.second, 0.0) - s0;
      } else {
        if (span.second <= eps) throw InputError("there is nothing to go through in this direction (flip it)");
        s0 = 0;
        L = span.second;
      }
      if (L <= eps) throw InputError("there is nothing to go through in this direction (flip it)");
      bool meets = false;
      for (auto& f : faces) {
        if (meets) break;
        gp_Trsf mv;
        mv.SetTranslation(gp_Vec(de.XYZ()) * s0);
        const TopoDS_Shape at = f.Moved(TopLoc_Location(mv));
        BRepPrimAPI_MakePrism pr(at, gp_Vec(de.XYZ()) * L, false, true);
        pr.Build();
        if (!pr.IsDone()) continue;
        for (auto& tg : targets) {
          BRepExtrema_DistShapeShape d(pr.Shape(), tg);
          if (d.IsDone() && (d.InnerSolution() || d.Value() <= 1e-6)) {
            meets = true;
            break;
          }
        }
      }
      if (!meets) throw InputError("the profile misses every body: there is nothing to go through (move the profile over a body)");
    } else if (ext.boolean("both", false)) {
      s0 = std::min(tmin, 0.0) - margin;
      L = std::max(tmax, 0.0) + margin - s0;
    } else {
      // The fast box is padded by the shapes' tolerances: a body that only touches the
      // profile plane on this side still reaches a hair past it.
      if (tmax <= std::max(1e-6, 1e-6 * c.front().Distance(c.back()))) throw InputError("there is nothing to go through in this direction (flip it)");
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
  } else if (kind == "to_vertex" || kind == "to_point") {
    // API 4: up to a point (a vertex of a body, or a point in space): the end cap lies
    // on the plane through it, parallel to the profile; offset goes further.
    if (tapered && kind == "to_vertex") throw InputError("taper is not available with a to-vertex extent");
    gp_Pnt p;
    if (kind == "to_vertex") {
      const int tid = idParam(ext.req("target"), "target");
      Indexed& ix = indexOf(tid);
      const int vi = (int)ext.req("vertex").num();
      if (vi < 0 || vi >= ix.v.Extent()) throw InputError("vertex index " + std::to_string(vi) + " out of range");
      p = BRep_Tool::Pnt(TopoDS::Vertex(ix.v(vi + 1)));
    } else {
      p = pnt(ext.req("point"));
    }
    const double t = gp_Vec(o, p).Dot(gp_Vec(de.XYZ())) + ext.num("offset", 0);
    if (fabs(t) <= 1e-9) throw InputError("the vertex lies in the profile's plane");
    if (t < 0) throw InputError("the vertex is behind the profile (flip the direction)");
    L = t;
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
  // Revolve (API 4): per profile segment, whether it lies on the axis (sweeps no face).
  std::vector<bool> onAxis;
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
// API 4: `contours` (the edges each contour runs along, input indices: a picked edge
// takes its tangent neighbours with it); chamfer `d2` (two distances: d on each edge's
// reference face, d2 on the other; the reference face is the edge's lower-numbered face,
// the other with flip:true); fillet `diagnose` (filletDiagnose: why it fails and the
// largest radius that works, nothing stored).
JV filletDiagnose(int sid, const JV& edges, double r);

JV opFillet(const JV& q, bool chamfer) {
  int sid = idParam(q.req("id"), "id");
  const JV& edges = q.req("edges");
  if (edges.size() == 0) throw InputError("no edges given");
  for (auto& e : edges.items()) edgeAt(sid, e);  // index check against the input
  const double size = chamfer ? q.num("d") : q.num("r");
  if (!(size > 0)) throw InputError(chamfer ? "chamfer distance must be > 0" : "fillet radius must be > 0");
  const bool two = chamfer && q.has("d2");
  const double d2 = two ? q.num("d2") : 0;
  if (two && !(d2 > 0)) throw InputError("the second chamfer distance must be > 0");
  const bool flipFaces = q.boolean("flip", false);
  if (!chamfer && q.boolean("diagnose", false)) return filletDiagnose(sid, edges, size);
  WorkCopies wc({sid});
  const int wid = wc.id(0);
  const TopoDS_Shape& s = wc.shape(0);
  TopoDS_Shape res;
  Handle(BRepTools_History) h;
  TopTools_ListOfShape args;
  args.Append(s);
  JV contours = JV::arr();
  auto contoursOf = [&](const BRepFilletAPI_LocalOperation& op) {
    Indexed& w = indexOf(wid);
    for (int ic = 1; ic <= op.NbContours(); ++ic) {
      JV c = JV::arr();
      for (int j = 1; j <= op.NbEdges(ic); ++j) {
        const int k = w.e.FindIndex(op.Edge(ic, j));
        if (k) c.push(k - 1);
      }
      contours.push(std::move(c));
    }
  };
  const double t0 = nowMs();
  if (!chamfer) {
    BRepFilletAPI_MakeFillet mf(s);
    for (auto& e : edges.items()) mf.Add(size, edgeAt(wid, e));
    contoursOf(mf);
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
    if (!two) {
      for (auto& e : edges.items()) mc.Add(size, edgeAt(wid, e));
    } else {
      const TopTools_IndexedDataMapOfShapeListOfShape& ef = edgeFacesOf(wid);
      Indexed& w = indexOf(wid);
      for (auto& e : edges.items()) {
        const TopoDS_Edge E = edgeAt(wid, e);
        std::vector<int> fs;
        const int k = ef.FindIndex(E);
        if (k)
          for (TopTools_ListIteratorOfListOfShape it(ef(k)); it.More(); it.Next()) {
            const int fi = w.f.FindIndex(it.Value());
            if (fi && std::find(fs.begin(), fs.end(), fi) == fs.end()) fs.push_back(fi);
          }
        std::sort(fs.begin(), fs.end());
        if (fs.empty()) throw InputError("edge " + std::to_string((int)e.num()) + " is on no face");
        const int pick = fs.size() > 1 && flipFaces ? fs[1] : fs[0];
        mc.Add(size, d2, E, TopoDS::Face(w.f(pick)));
      }
    }
    contoursOf(mc);
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
  r.set("contours", std::move(contours));
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

// Hollow a body to wall thickness t, opening the given faces. API 4: outside:true puts the
// wall outside the body's faces (the body becomes the cavity) instead of inside.
JV opShell(const JV& q) {
  int sid = idParam(q.req("id"), "id");
  for (auto& f : q.req("faces").items()) faceAt(sid, f);  // index check against the input
  const double t = q.num("t");
  if (!(t > 0)) throw InputError("shell thickness must be > 0");
  const bool outside = q.boolean("outside", false);
  WorkCopies wc({sid});
  const int wid = wc.id(0);
  const TopoDS_Shape& s = wc.shape(0);
  TopTools_ListOfShape rm;
  for (auto& f : q.req("faces").items()) rm.Append(faceAt(wid, f));
  const double t0 = nowMs();
  BRepOffsetAPI_MakeThickSolid mts;
  mts.MakeThickSolidByJoin(s, rm, outside ? t : -t, q.num("tol", 1e-3), BRepOffset_Skin, false, false, GeomAbs_Intersection);
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
// P4b (R5): does the shape have faces made from a sketch's B-spline: an extrusion or revolution of a
// B-spline curve (or, with flatToo, a flat face bounded by a B-spline edge: a sketch region)? Their
// volumes are integrated over the knot spans (props). STEP imports keep their own B-spline surfaces,
// and the B-spline edges a boolean makes lie on other faces, so neither is touched (the native
// reference values stay those of the default integration).
bool sketchSplineFaces(const TopoDS_Shape& s, bool flatToo = false) {
  auto splineCurve = [](Handle(Geom_Curve) c) {
    while (!c.IsNull()) {
      Handle(Geom_TrimmedCurve) t = Handle(Geom_TrimmedCurve)::DownCast(c);
      if (t.IsNull()) break;
      c = t->BasisCurve();
    }
    return !c.IsNull() && (c->IsKind(STANDARD_TYPE(Geom_BSplineCurve)) || c->IsKind(STANDARD_TYPE(Geom_BezierCurve)));
  };
  for (TopExp_Explorer fx(s, TopAbs_FACE); fx.More(); fx.Next()) {
    const TopoDS_Face& F = TopoDS::Face(fx.Current());
    Handle(Geom_Surface) g = BRep_Tool::Surface(F);
    while (!g.IsNull()) {
      Handle(Geom_RectangularTrimmedSurface) t = Handle(Geom_RectangularTrimmedSurface)::DownCast(g);
      if (t.IsNull()) break;
      g = t->BasisSurface();
    }
    if (g.IsNull()) continue;
    Handle(Geom_SweptSurface) sw = Handle(Geom_SweptSurface)::DownCast(g);
    if (!sw.IsNull() && splineCurve(sw->BasisCurve())) return true;
    if (flatToo && g->IsKind(STANDARD_TYPE(Geom_Plane))) {
      for (TopExp_Explorer ex(F, TopAbs_EDGE); ex.More(); ex.Next()) {
        double f, l;
        if (splineCurve(BRep_Tool::Curve(TopoDS::Edge(ex.Current()), f, l))) return true;
      }
    }
  }
  return false;
}

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
    } else if (sketchSplineFaces(s)) {
      // P4b (R5): faces swept from a sketch's B-spline (or flat faces bounded by one): the default
      // integration was 0.04 % off on them (a closed spline's prism fused with another) and the eps
      // one worse; Gauss-Kronrod over the knot spans is exact to 1e-12 here (`integration` says so).
      r.set("volume_error", BRepGProp::VolumePropertiesGK(s, vp, 1e-9, Standard_False, Standard_True));
      r.set("integration", "spans");
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
  // API 4 (REFERENCE's R1): edge ends (first/last point in parameter order, their vertex
  // indices, a line's direction) and each vertex's faces.
  const bool edgeEnds = q.boolean("edge_ends", false);
  const bool vertexFaces = q.boolean("vertex_faces", false);
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
      if (edgeEnds) {
        TopoDS_Vertex v1, v2;
        TopExp::Vertices(E, v1, v2);
        if (!v1.IsNull()) {
          e.set("first", p3(BRep_Tool::Pnt(v1)));
          e.set("last", p3(BRep_Tool::Pnt(v1)));
        }
        JV vs = JV::arr();
        vs.push(v1.IsNull() ? -1 : ix.v.FindIndex(v1) - 1);
        vs.push(v1.IsNull() ? -1 : ix.v.FindIndex(v1) - 1);
        e.set("vertices", std::move(vs));
      }
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
      if (edgeEnds) {
        const gp_Pnt pf = c.Value(c.FirstParameter()), pl = c.Value(c.LastParameter());
        e.set("first", p3(pf));
        e.set("last", p3(pl));
        TopoDS_Vertex v1, v2;
        TopExp::Vertices(E, v1, v2);
        if (!v1.IsNull() && !v2.IsNull() && BRep_Tool::Pnt(v1).Distance(pf) > BRep_Tool::Pnt(v2).Distance(pf)) std::swap(v1, v2);
        JV vs = JV::arr();
        vs.push(v1.IsNull() ? -1 : ix.v.FindIndex(v1) - 1);
        vs.push(v2.IsNull() ? -1 : ix.v.FindIndex(v2) - 1);
        e.set("vertices", std::move(vs));
        if (c.GetType() == GeomAbs_Line && pf.Distance(pl) > 1e-12) e.set("dir", d3(gp_Dir(gp_Vec(pf, pl))));
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
  TopTools_IndexedDataMapOfShapeListOfShape vf;
  if (vertexFaces && !vsel.empty()) TopExp::MapShapesAndAncestors(entryOf(sid).shape, TopAbs_VERTEX, TopAbs_FACE, vf);
  for (int i0 : vsel) {
    JV v = JV::obj();
    v.set("i", i0);
    v.set("p", p3(BRep_Tool::Pnt(TopoDS::Vertex(ix.v(i0 + 1)))));
    if (vertexFaces) {
      std::vector<int> fs;
      const int k = vf.FindIndex(ix.v(i0 + 1));
      if (k)
        for (TopTools_ListIteratorOfListOfShape it(vf(k)); it.More(); it.Next()) {
          const int fi = ix.f.FindIndex(it.Value()) - 1;
          if (fi >= 0 && std::find(fs.begin(), fs.end(), fi) == fs.end()) fs.push_back(fi);
        }
      std::sort(fs.begin(), fs.end());
      JV fl = JV::arr();
      for (int fi : fs) fl.push(fi);
      v.set("faces", std::move(fl));
    }
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

// The BinTools format every BREP this kernel writes uses, pinned (not
// BinTools_FormatVersion_CURRENT): the app's OCP 7.9.3 reads versions 1 to 4, so a
// later OCCT in the kernel can never write a BREP the app refuses (LINK, C2).
const BinTools_FormatVersion kBinFormat = BinTools_FormatVersion_VERSION_4;

// The shapes, in order, as one compound in OCCT's binary BREP format (BinTools,
// format version 4, no triangulation). Buffer `brep`.
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
    BinTools::Write(all, os, Standard_False, Standard_False, kBinFormat);
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

// ------------------------------------------------------------ link_export ---

// The design as the app links it (host API 1.5, "Linking a geometry"): one
// compound of the SOLIDS of the given shapes, in order (a shape's solids in
// TopExp_Explorer(SOLID) order), written with BinTools format 4 (kBinFormat), no
// triangulation. Buffer `brep`.
// With it, the face numbering the app uses (magnusim_sdk.link.face_visits): every
// visit of TopExp_Explorer(compound, FACE), counted with no de-duplication (a face
// two solids share is visited once per solid), each with the 1-based solid it is
// explored in. Per visit the result gives the solid (`visit_body`, 1-based) and the
// face's index in its own shape's face map (`visit_face`, 0-based: the MapShapes
// index the rest of this API uses), so the page can name each visit.
// `solids`: per solid, the index of its shape in `ids` (`src`, 0-based), its place
// among that shape's solids (`piece`, 1-based) and its face visits (`faces`).
// `empty`: the indices in `ids` of the shapes with no solid (left out).
JV opLinkExport(const JV& q) {
  std::vector<int> ids = idList(q, "ids", true);
  if (ids.empty()) throw InputError("link_export needs at least one shape");
  const double t0 = nowMs();
  BRep_Builder bb;
  TopoDS_Compound all;
  bb.MakeCompound(all);
  JV empty = JV::arr();
  std::vector<int> srcOf;    // per solid (0-based): its shape's index in ids
  std::vector<int> pieceOf;  // per solid: its place among its shape's solids (1-based)
  for (size_t i = 0; i < ids.size(); i++) {
    int piece = 0;
    for (TopExp_Explorer ex(shapeOf(ids[i]), TopAbs_SOLID); ex.More(); ex.Next()) {
      bb.Add(all, ex.Current());
      srcOf.push_back((int)i);
      pieceOf.push_back(++piece);
    }
    if (!piece) empty.push((double)i);
  }
  if (srcOf.empty()) throw InputError("none of the shapes has a solid");

  // Every face visit over the compound (the app's face_visits): the flat FACE walk,
  // with the body of the solid explored at that visit. The compound holds solids
  // only, so the flat walk is the solid-by-solid walk; both are taken, and must agree.
  std::vector<TopoDS_Shape> flat;
  for (TopExp_Explorer ex(all, TopAbs_FACE); ex.More(); ex.Next()) flat.push_back(ex.Current());
  JV visitBody = JV::arr();
  JV visitFace = JV::arr();
  std::vector<int> facesOf;
  size_t j = 0;
  int body = 0;
  for (TopExp_Explorer sx(all, TopAbs_SOLID); sx.More(); sx.Next()) {
    body++;
    if ((size_t)body > srcOf.size()) throw OcctError("the export has more solids than it was given");
    Indexed& ix = indexOf(ids[srcOf[body - 1]]);
    int n = 0;
    for (TopExp_Explorer fx(sx.Current(), TopAbs_FACE); fx.More(); fx.Next()) {
      if (j >= flat.size() || !flat[j].IsEqual(fx.Current())) throw OcctError("the face walk of the export does not match its solids' walk");
      const int at = ix.f.FindIndex(fx.Current());
      if (at < 1) throw OcctError("a face of the export is not in its shape's face map");
      visitBody.push((double)body);
      visitFace.push((double)(at - 1));
      j++;
      n++;
    }
    facesOf.push_back(n);
  }
  if (j != flat.size()) throw OcctError("the export has faces outside its solids");
  if (facesOf.size() != srcOf.size()) throw OcctError("the export lost a solid");
  JV solids = JV::arr();
  for (size_t k = 0; k < srcOf.size(); k++) {
    JV s = JV::obj();
    s.set("src", (double)srcOf[k]);
    s.set("piece", (double)pieceOf[k]);
    s.set("faces", (double)facesOf[k]);
    solids.push(std::move(s));
  }

  MBuf<uint8_t> buf;
  {
    MBufOut sb(buf);
    std::ostream os(&sb);
    BinTools::Write(all, os, Standard_False, Standard_False, kBinFormat);
    os.flush();
    if (!os) throw OcctError("writing the BREP failed");
  }
  const double t1 = nowMs();
  JV r = JV::obj();
  r.set("bytes", (double)buf.n);
  r.set("occt", OCC_VERSION_COMPLETE);
  r.set("format_version", (double)kBinFormat);
  r.set("solids", std::move(solids));
  r.set("empty", std::move(empty));
  r.set("visit_body", std::move(visitBody));
  r.set("visit_face", std::move(visitFace));
  JV tm = JV::obj();
  tm.set("ms", t1 - t0);
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

// The solid between a face and its offset by d (d > 0 along the face's outward normal,
// d < 0 against it): BRepOffset_MakeOffset thickening a copy of the face alone, its
// side walls ruled along the normals at the face's edges. Turned outside out when OCCT
// made it inside out (negative volume). `far` is the offset face (the face of the tool
// that shares no edge with the face); `walls` are the others, with their edges.
struct Thick {
  TopoDS_Shape tool;
  TopoDS_Shape far;
  std::vector<TopoDS_Shape> walls;
  std::vector<TopTools_IndexedMapOfShape> wallEdges;
};

Thick thickenFace(const TopoDS_Face& F, double d, const std::string& what) {
  BRepOffset_MakeOffset mo;
  mo.Initialize(F, d, 1e-7, BRepOffset_Skin, Standard_False, Standard_False, GeomAbs_Intersection, Standard_True, Standard_False);
  try {
    mo.MakeThickSolid();
  } catch (const Standard_Failure& e) {
    throw OcctError("press-pull failed: OCCT could not thicken " + what + " (" + std::string(e.GetMessageString() ? e.GetMessageString() : "exception") + "); the body is unchanged");
  }
  if (!mo.IsDone() || mo.Shape().IsNull()) throw OcctError("press-pull failed: OCCT could not thicken " + what + "; the body is unchanged");
  Thick t;
  t.tool = mo.Shape();
  GProp_GProps gp;
  BRepGProp::VolumeProperties(t.tool, gp);
  if (!(fabs(gp.Mass()) > 1e-12)) throw OcctError("press-pull failed: thickening " + what + " gave no volume; the body is unchanged");
  if (gp.Mass() < 0) t.tool.Reverse();
  TopTools_IndexedMapOfShape own;
  TopExp::MapShapes(F, TopAbs_EDGE, own);
  for (TopExp_Explorer ex(t.tool, TopAbs_FACE); ex.More(); ex.Next()) {
    const TopoDS_Shape& G = ex.Current();
    if (G.IsSame(F)) continue;
    TopTools_IndexedMapOfShape ge;
    TopExp::MapShapes(G, TopAbs_EDGE, ge);
    bool touches = false;
    for (int i = 1; i <= ge.Extent() && !touches; ++i) touches = own.Contains(ge(i));
    if (!touches) {
      if (t.far.IsNull()) t.far = G;
    } else {
      t.walls.push_back(G);
      t.wallEdges.push_back(ge);
    }
  }
  return t;
}

// Press-pull faces of one body (work copy): a tool solid per face (a flat face's prism
// along its own outward normal; API 6: a curved face's thickened solid, Thick above),
// d > 0 fused, d < 0 cut by |d|, all tools in one boolean with the body (no glue: a tool
// can reach another wall of a non-convex body), then UnifySameDomain, history merged at
// every step. A face whose neighbours are perpendicular to it grows or shrinks exactly; a
// slanted neighbour is not extended (a step forms; offset_faces extends it). `moved[i]`:
// the result face where faces[i] now lies (the tool's far face; -1 if it is gone),
// reported `modified` from that input face in the history so it keeps its name.
// `sides["<face>:<edge>"]`: the result face swept from that input edge (history
// `generated` from the edge), absent where the side merged with a neighbour that already
// lay in its surface.
JV pressPullRun(int sid, const std::vector<int>& fidx, double d, double fuzzy, const std::string& glue, bool unifyOn, bool check) {
  WorkCopies wc({sid});
  const int wid = wc.id(0);
  Indexed& in = indexOf(wid);
  const double t0 = nowMs();
  struct Prism {
    int face;
    TopoDS_Face src;
    std::shared_ptr<BRepBuilderAPI_Copy> cp;
    std::shared_ptr<BRepPrimAPI_MakePrism> mp;  // a flat face
    std::shared_ptr<Thick> th;                  // a curved face (API 6)
    TopoDS_Shape far() const { return mp ? mp->LastShape() : th->far; }
    // The tool's faces swept from the copy's edge Ec.
    std::vector<TopoDS_Shape> swept(const TopoDS_Shape& Ec) const {
      std::vector<TopoDS_Shape> out;
      if (mp) {
        for (TopTools_ListIteratorOfListOfShape it(mp->Generated(Ec)); it.More(); it.Next()) out.push_back(it.Value());
      } else {
        for (size_t k = 0; k < th->walls.size(); ++k)
          if (th->wallEdges[k].Contains(Ec)) out.push_back(th->walls[k]);
      }
      return out;
    }
  };
  std::vector<Prism> prisms;
  TopTools_ListOfShape tools;
  for (int i : fidx) {
    TopoDS_Face F = TopoDS::Face(in.f(i + 1));
    gp_Pln pl;
    gp_Dir nn;
    auto cp = std::make_shared<BRepBuilderAPI_Copy>(F, Standard_True, Standard_False);
    if (planarFace(F, pl, nn)) {
      gp_Vec v(nn.XYZ());
      v *= d;
      auto mp = std::make_shared<BRepPrimAPI_MakePrism>(cp->Shape(), v, Standard_False, Standard_True);
      mp->Build();
      if (!mp->IsDone()) throw OcctError("press-pull failed: no prism for face " + std::to_string(i) + "; the body is unchanged");
      tools.Append(mp->Shape());
      prisms.push_back({i, F, cp, mp, nullptr});
    } else {
      auto th = std::make_shared<Thick>(thickenFace(TopoDS::Face(cp->Shape()), d, "face " + std::to_string(i) + " (" + surfWords(F) + ")"));
      if (th->far.IsNull()) throw OcctError("press-pull failed: thickening face " + std::to_string(i) + " gave no offset face; the body is unchanged");
      tools.Append(th->tool);
      prisms.push_back({i, F, cp, nullptr, th});
    }
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
  const Unified uni = unifyChecked(bop->Shape(), bh, unifyOn, check);
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
    std::vector<int> m = facesThrough(*hist, p.far(), out);
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
      for (const TopoDS_Shape& g : p.swept(Ec))
        for (int k : facesThrough(*hist, g, out))
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
    (void)F;
    fidx.push_back(i);
  }
  return pressPullRun(sid, fidx, d, fuzzy, glue, unifyOn, q.boolean("check", true));
}


// ----------------------------------------------------------- offset_faces ---

// API 6: offset picked faces of one body by d along their outward normals (d > 0 adds
// material) as one true offset: BRepOffset_MakeOffset with d on each picked face, 0 on
// every other face and join type Intersection, so the neighbours are extended or trimmed
// to meet the moved faces (no step). A cylinder's, sphere's or cone's radius changes; a
// fillet (a cylinder or torus blend between two tangent faces) is taken off and its edge
// rounded again at the new radius, so it stays tangent. OCCT moves faces that are
// tangent to a moved one with it; `tangent` lists them.

// What a picked face is: its surface, its role ("flat", "bore", "cylinder", "cone",
// "sphere", "torus", "fillet", "surface"), its radius before and after, and how far it
// can move this way before a radius reaches 0 (`limit`, with words for it).
struct OffPick {
  int face = -1;
  std::string type, role;
  bool convex = false;
  bool hasRadius = false;
  double radius = 0, newRadius = 0;
  double limit = HUGE_VAL;
  std::string limitWords;
  bool blend = false;
  int s1 = -1, s2 = -1;
  std::vector<int> tangent;
  double area = 0;  // the face's area (mm2)
  double span = 0;  // a fillet's arc angle (rad)
};

// A face's middle (of its parameter box) and its outward normal there.
bool faceMid(const TopoDS_Face& F, gp_Pnt& p, gp_Dir& n, double& u, double& v) {
  double u0 = 0, u1 = 0, v0 = 0, v1 = 0;
  BRepTools::UVBounds(F, u0, u1, v0, v1);
  u = 0.5 * (u0 + u1);
  v = 0.5 * (v0 + v1);
  BRepAdaptor_Surface s(F, false);
  gp_Vec du, dv;
  s.D1(u, v, p, du, dv);
  gp_Vec nn = du.Crossed(dv);
  if (nn.Magnitude() < 1e-12) return false;
  n = gp_Dir(nn);
  if (F.Orientation() == TopAbs_REVERSED) n.Reverse();
  return true;
}

// The faces next to `F` across a smooth (tangent) edge of it, by index in `sid`.
std::set<int> tangentNeighbours(int sid, const TopoDS_Face& F) {
  Indexed& ix = indexOf(sid);
  const auto& ef = edgeFacesOf(sid);
  std::set<int> out;
  for (TopExp_Explorer ex(F, TopAbs_EDGE); ex.More(); ex.Next()) {
    const TopoDS_Edge& E = TopoDS::Edge(ex.Current());
    if (BRep_Tool::Degenerated(E) || BRep_Tool::IsClosed(E, F)) continue;
    const int k = ef.FindIndex(E);
    if (!k) continue;
    for (TopTools_ListIteratorOfListOfShape it(ef(k)); it.More(); it.Next()) {
      if (it.Value().IsSame(F)) continue;
      const TopoDS_Face& N = TopoDS::Face(it.Value());
      if (sameSurface(F, N) || smoothBetween(F, N, E)) {
        const int j = ix.f.FindIndex(N);
        if (j) out.insert(j - 1);
      }
    }
  }
  return out;
}

OffPick describeOffPick(int sid, int fi, double d) {
  Indexed& ix = indexOf(sid);
  const TopoDS_Face F = TopoDS::Face(ix.f(fi + 1));
  OffPick p;
  p.face = fi;
  BRepAdaptor_Surface s(F, false);
  p.type = surfType(s.GetType());
  gp_Pnt at;
  gp_Dir n;
  double u = 0, v = 0;
  const bool haveN = faceMid(F, at, n, u, v);
  auto radialFromAxis = [&](const gp_Ax1& ax) {
    gp_Vec w(ax.Location(), at);
    gp_Vec along(ax.Direction());
    along *= w.Dot(along);
    return w - along;
  };
  const double ad = fabs(d);
  // grows: the radius gets bigger with this d.
  auto setRadius = [&](double r, bool grows, double per, const char* shrinkWords) {
    p.hasRadius = true;
    p.radius = r;
    p.newRadius = grows ? r + ad * per : r - ad * per;
    if (!grows) {
      p.limit = r / per;
      p.limitWords = shrinkWords;
    }
  };
  switch (s.GetType()) {
    case GeomAbs_Plane:
      p.role = "flat";
      break;
    case GeomAbs_Cylinder: {
      const gp_Cylinder c = s.Cylinder();
      p.convex = haveN && radialFromAxis(c.Axis()).Dot(gp_Vec(n)) > 0;
      p.role = p.convex ? "cylinder" : "bore";
      break;
    }
    case GeomAbs_Cone: {
      const gp_Cone c = s.Cone();
      p.convex = haveN && radialFromAxis(c.Axis()).Dot(gp_Vec(n)) > 0;
      p.role = "cone";
      double u0 = 0, u1 = 0, v0 = 0, v1 = 0;
      BRepTools::UVBounds(F, u0, u1, v0, v1);
      const double sa = sin(c.SemiAngle()), ca = cos(c.SemiAngle());
      const double r0 = c.RefRadius() + v0 * sa, r1 = c.RefRadius() + v1 * sa;
      const double rmax = std::max(fabs(r0), fabs(r1));
      const double rmin = r0 * r1 <= 0 ? 0 : std::min(fabs(r0), fabs(r1));
      const bool grows = p.convex == (d > 0);
      // No radius words for a cone (fix round 1, B3): where a neighbour is extended to meet
      // it (a cylinder under it) its wide end stays where it was and moves along the axis.
      p.radius = rmax;
      p.newRadius = grows ? rmax + ad / fabs(ca) : rmax - ad / fabs(ca);
      if (!grows && rmin > 1e-9) {
        p.limit = rmin * fabs(ca);
        p.limitWords = "the cone would pass its tip";
      }
      break;
    }
    case GeomAbs_Sphere: {
      const gp_Sphere sp = s.Sphere();
      p.convex = haveN && gp_Vec(sp.Location(), at).Dot(gp_Vec(n)) > 0;
      p.role = "sphere";
      setRadius(sp.Radius(), p.convex == (d > 0), 1, p.convex ? "the sphere would shrink to nothing" : "the spherical hollow would close");
      break;
    }
    case GeomAbs_Torus: {
      const gp_Torus t = s.Torus();
      gp_Vec rad = radialFromAxis(t.Axis());
      gp_Pnt q = t.Location();
      if (rad.Magnitude() > 1e-12) q.Translate(rad.Normalized() * t.MajorRadius());
      gp_Vec ax(t.Axis().Direction());
      gp_Vec w(t.Location(), at);
      q.Translate(ax * w.Dot(ax));
      p.convex = haveN && gp_Vec(q, at).Dot(gp_Vec(n)) > 0;
      p.role = "torus";
      setRadius(t.MinorRadius(), p.convex == (d > 0), 1, "the torus's tube would close");
      break;
    }
    default:
      p.role = "surface";
      break;
  }
  if (p.role == "cylinder" || p.role == "bore") {
    const gp_Cylinder c = s.Cylinder();
    setRadius(c.Radius(), p.convex == (d > 0), 1, p.convex ? "the cylinder would shrink to nothing" : "the hole would close");
  }
  // A fillet: a cylinder or torus of less than half a turn across, tangent to two faces.
  // Its radius changes and it stays tangent: smaller as it moves out of a convex corner,
  // larger as it moves out of a concave one.
  if (p.role == "cylinder" || p.role == "bore" || p.role == "torus") {
    double u0 = 0, u1 = 0, v0 = 0, v1 = 0;
    BRepTools::UVBounds(F, u0, u1, v0, v1);
    const double span = s.GetType() == GeomAbs_Cylinder ? u1 - u0 : v1 - v0;
    const std::set<int> tn = tangentNeighbours(sid, F);
    if (span < M_PI - 1e-6 && tn.size() == 2) {
      p.blend = true;
      p.s1 = *tn.begin();
      p.s2 = *tn.rbegin();
      p.role = "fillet";
      const double r = s.GetType() == GeomAbs_Cylinder ? s.Cylinder().Radius() : s.Torus().MinorRadius();
      p.limit = HUGE_VAL;
      p.limitWords.clear();
      // Out of a convex corner (d > 0 on a convex fillet) the corner gets sharper.
      setRadius(r, p.convex != (d > 0), 1, "the fillet's radius would reach 0");
      p.span = span;
    }
  }
  GProp_GProps fp;
  BRepGProp::SurfaceProperties(F, fp);
  p.area = fabs(fp.Mass());
  return p;
}

std::string offsetErrorWords(BRepOffset_Error e) {
  switch (e) {
    case BRepOffset_BadNormalsOnGeometry: return "OCCT found no normal on a surface";
    case BRepOffset_C0Geometry: return "a surface is not smooth enough (C0) to offset";
    case BRepOffset_NullOffset: return "nothing to offset";
    case BRepOffset_NotConnectedShell: return "the faces are not connected";
    case BRepOffset_CannotTrimEdges: return "OCCT could not trim the edges of the offset faces";
    case BRepOffset_CannotFuseVertices: return "OCCT could not join the corners of the offset faces";
    case BRepOffset_CannotExtentEdge: return "OCCT could not extend an edge to meet the offset faces";
    case BRepOffset_MixedConnectivity: return "faces meet partly smoothly and partly at a sharp edge";
    default: return "OCCT's offset failed";
  }
}

// A face that is taken off before the move and put back after it (fix round 1): a fillet
// picked for a new radius, or a fillet or chamfer next to a moved face that keeps its size
// (a press-pull of a box top with rounded or chamfered edges moves the top; the side walls
// stay and the fillets stay r 3, as SolidWorks and Fusion do; OCCT's offset alone would
// move the tangent walls with it).
struct Rework {
  int face = -1;
  bool chamfer = false;
  bool picked = false;
  double r = 0;  // the fillet radius to round at
};

// One offset run on a work copy (`wid`): the reworked faces taken off, the plain picks
// offset, the reworked edges rounded or chamfered again. On a refusal `code` says why:
// "fillet" (a fillet or chamfer could not be taken off or put back), "occt" (OCCT's offset
// failed: `detail`). `reworked`: per input face, the result faces that replace it (a
// re-rounded fillet, a chamfer put back, a cylinder at its new radius).
struct OffRun {
  TopoDS_Shape shape;
  Handle(BRepTools_History) hist;
  std::string code, words, detail;
  int face = -1;
  std::map<int, std::vector<TopoDS_Shape>> reworked;
  bool ok() const { return code.empty(); }
};

// What `s` became through `h` (itself when untouched; nothing when removed).
std::vector<TopoDS_Shape> imagesThrough(const BRepTools_History& h, const TopoDS_Shape& s) {
  std::vector<TopoDS_Shape> out;
  for (TopTools_ListIteratorOfListOfShape it(h.Modified(s)); it.More(); it.Next()) out.push_back(it.Value());
  if (out.empty() && !h.IsRemoved(s)) out.push_back(s);
  return out;
}

std::vector<TopoDS_Shape> imagesThrough(const BRepTools_History& h, const std::vector<TopoDS_Shape>& ss) {
  std::vector<TopoDS_Shape> out;
  for (auto& s : ss)
    for (auto& g : imagesThrough(h, s)) {
      bool dup = false;
      for (auto& x : out) dup = dup || x.IsSame(g);
      if (!dup) out.push_back(g);
    }
  return out;
}

// BRepOffset_MakeOffset reports every face and edge of its result as generated from the
// input one it offsets (by 0 or by d) and the inputs as deleted: here that is a
// modification, so names carry over.
Handle(BRepTools_History) offsetHistory(const TopoDS_Shape& in, BRepOffset_MakeOffset& mo) {
  Handle(BRepTools_History) h = new BRepTools_History();
  for (TopAbs_ShapeEnum t : {TopAbs_FACE, TopAbs_EDGE, TopAbs_VERTEX}) {
    TopTools_IndexedMapOfShape m;
    TopExp::MapShapes(in, t, m);
    for (int i = 1; i <= m.Extent(); ++i) {
      const TopoDS_Shape& S = m(i);
      bool any = false;
      for (TopTools_ListIteratorOfListOfShape it(mo.Modified(S)); it.More(); it.Next())
        if (it.Value().ShapeType() == t && !it.Value().IsSame(S)) {
          h->AddModified(S, it.Value());
          any = true;
        }
      for (TopTools_ListIteratorOfListOfShape it(mo.Generated(S)); it.More(); it.Next()) {
        if (it.Value().IsSame(S)) {
          any = true;
          continue;
        }
        if (it.Value().ShapeType() == t) {
          h->AddModified(S, it.Value());
          any = true;
        } else if (t != TopAbs_VERTEX) {
          h->AddGenerated(S, it.Value());
        }
      }
      if (!any && mo.IsDeleted(S)) h->Remove(S);
    }
  }
  return h;
}

// The input faces next to input face `fi` (sharing an edge).
std::set<int> neighboursOf(int id, int fi) {
  Indexed& ix = indexOf(id);
  const auto& ef = edgeFacesOf(id);
  std::set<int> out;
  for (TopExp_Explorer ex(ix.f(fi + 1), TopAbs_EDGE); ex.More(); ex.Next()) {
    const int k = ef.FindIndex(ex.Current());
    if (!k) continue;
    for (TopTools_ListIteratorOfListOfShape it(ef(k)); it.More(); it.Next()) {
      const int j = ix.f.FindIndex(it.Value());
      if (j && j - 1 != fi) out.insert(j - 1);
    }
  }
  return out;
}

OffRun runOffset(int wid, const std::vector<OffPick>& picks, const std::vector<Rework>& rw, double d) {
  OffRun r;
  Indexed& in = indexOf(wid);
  TopoDS_Shape cur = shapeOf(wid);
  Handle(BRepTools_History) H = new BRepTools_History();
  std::vector<const OffPick*> plain;
  for (auto& p : picks)
    if (!p.blend) plain.push_back(&p);
  struct Restored {
    const Rework* w;
    std::vector<TopoDS_Shape> edges;
    double d1 = 0, d2 = 0;
    std::vector<TopoDS_Shape> f1;  // the face d1 is measured on (chamfer)
  };
  std::vector<Restored> rest;
  auto fail = [&](const char* code, const std::string& words, int face) {
    r.code = code;
    r.words = words;
    r.face = face;
    return r;
  };
  if (!rw.empty()) {
    BRepAlgoAPI_Defeaturing df;
    df.SetShape(cur);
    for (auto& w : rw) df.AddFaceToRemove(in.f(w.face + 1));
    df.SetRunParallel(false);
    df.SetToFillHistory(true);
    try {
      df.Build();
    } catch (const Standard_Failure&) {
    }
    if (!df.IsDone() || df.HasErrors() || df.Shape().IsNull()) return fail("fillet", "OCCT could not take the fillet or chamfer off to put it back", rw[0].face);
    const TopoDS_Shape D = df.Shape();
    Handle(BRepTools_History) hD = df.History();
    if (hD.IsNull()) {
      TopTools_ListOfShape args;
      args.Append(cur);
      hD = new BRepTools_History(args, df);
    }
    // Edges of D that were not there before: where the faces beside a removed face now meet.
    TopTools_IndexedMapOfShape old;
    for (int i = 1; i <= in.e.Extent(); ++i)
      for (auto& g : imagesThrough(*hD, in.e(i))) old.Add(g);
    TopTools_IndexedMapOfShape dEdges;
    TopExp::MapShapes(D, TopAbs_EDGE, dEdges);
    TopTools_IndexedDataMapOfShapeListOfShape dEF;
    TopExp::MapShapesAndAncestors(D, TopAbs_EDGE, TopAbs_FACE, dEF);
    const auto& ef = edgeFacesOf(wid);
    for (auto& w : rw) {
      const TopoDS_Shape& C = in.f(w.face + 1);
      TopTools_IndexedMapOfShape nb;
      std::vector<std::pair<TopoDS_Shape, TopoDS_Shape>> spring;  // (edge of C, the input face across it)
      for (TopExp_Explorer ex(C, TopAbs_EDGE); ex.More(); ex.Next()) {
        const int k = ef.FindIndex(ex.Current());
        if (!k) continue;
        for (TopTools_ListIteratorOfListOfShape it(ef(k)); it.More(); it.Next()) {
          if (it.Value().IsSame(C)) continue;
          for (auto& g : imagesThrough(*hD, it.Value())) nb.Add(g);
          spring.push_back({ex.Current(), it.Value()});
        }
      }
      Restored R;
      R.w = &w;
      for (int i = 1; i <= dEdges.Extent(); ++i) {
        const TopoDS_Shape& E = dEdges(i);
        if (old.Contains(E) || BRep_Tool::Degenerated(TopoDS::Edge(E))) continue;
        const int k = dEF.FindIndex(E);
        if (!k) continue;
        int on = 0;
        for (TopTools_ListIteratorOfListOfShape it(dEF(k)); it.More(); it.Next())
          if (nb.Contains(it.Value())) ++on;
        if (on >= 2) R.edges.push_back(E);
      }
      if (R.edges.empty()) return fail("fillet", w.chamfer ? "the faces beside the chamfer do not meet once it is taken off" : "the faces beside the fillet do not meet once it is taken off", w.face);
      if (w.chamfer) {
        // One straight restored edge; the chamfer's size on each of its two (flat) faces.
        if (R.edges.size() != 1) return fail("fillet", "the chamfer does not run along one straight edge", w.face);
        BRepAdaptor_Curve ce(TopoDS::Edge(R.edges[0]));
        if (ce.GetType() != GeomAbs_Line) return fail("fillet", "the chamfer does not run along one straight edge", w.face);
        const gp_Lin L = ce.Line();
        const int k = dEF.FindIndex(R.edges[0]);
        std::vector<TopoDS_Shape> fs;
        for (TopTools_ListIteratorOfListOfShape it(dEF(k)); it.More(); it.Next()) {
          bool dup = false;
          for (auto& x : fs) dup = dup || x.IsSame(it.Value());
          if (!dup) fs.push_back(it.Value());
        }
        if (fs.size() != 2) return fail("fillet", "the chamfer does not lie between two faces", w.face);
        double dist[2] = {-1, -1};
        for (int s = 0; s < 2; ++s) {
          BRepAdaptor_Surface as(TopoDS::Face(fs[s]), false);
          if (as.GetType() != GeomAbs_Plane) return fail("fillet", "a face beside the chamfer is curved", w.face);
          for (auto& sp : spring) {
            bool here = false;
            for (auto& g : imagesThrough(*hD, sp.second)) here = here || g.IsSame(fs[s]);
            if (!here) continue;
            BRepAdaptor_Curve c(TopoDS::Edge(sp.first));
            const gp_Pnt m = c.Value(0.5 * (c.FirstParameter() + c.LastParameter()));
            dist[s] = L.Distance(m);
          }
        }
        if (!(dist[0] > 1e-7) || !(dist[1] > 1e-7)) return fail("fillet", "the chamfer's size could not be measured", w.face);
        R.d1 = dist[0];
        R.d2 = dist[1];
        R.f1 = {fs[0]};
      }
      rest.push_back(R);
    }
    H->Merge(hD);
    cur = D;
  }
  if (!plain.empty()) {
    BRepOffset_MakeOffset mo;
    mo.Initialize(cur, 0.0, 1e-7, BRepOffset_Skin, Standard_False, Standard_False, GeomAbs_Intersection, Standard_False, Standard_False);
    for (auto* p : plain)
      for (auto& g : imagesThrough(*H, in.f(p->face + 1))) mo.SetOffsetOnFace(TopoDS::Face(g), d);
    try {
      mo.MakeOffsetShape();
    } catch (const Standard_Failure& e) {
      r.code = "occt";
      r.detail = std::string("OCCT's offset stopped: ") + (e.GetMessageString() && *e.GetMessageString() ? e.GetMessageString() : "an exception");
      return r;
    }
    if (!mo.IsDone() || mo.Shape().IsNull()) {
      r.code = "occt";
      r.detail = mo.IsDone() ? "OCCT's offset returned no shape" : offsetErrorWords(mo.Error());
      return r;
    }
    Handle(BRepTools_History) hO = offsetHistory(cur, mo);
    H->Merge(hO);
    for (auto& R : rest) {
      R.edges = imagesThrough(*hO, R.edges);
      R.f1 = imagesThrough(*hO, R.f1);
    }
    cur = mo.Shape();
  }
  // Fillets back (picked: at the new radius; carried: at their own), then chamfers.
  bool anyFillet = false, anyChamfer = false;
  for (auto& R : rest) (R.w->chamfer ? anyChamfer : anyFillet) = true;
  if (anyFillet) {
    BRepFilletAPI_MakeFillet mf(cur);
    int first = -1;
    for (auto& R : rest) {
      if (R.w->chamfer) continue;
      if (first < 0) first = R.w->face;
      for (auto& E : R.edges) mf.Add(R.w->r, TopoDS::Edge(E));
    }
    try {
      mf.Build();
    } catch (const Standard_Failure&) {
    }
    if (!mf.IsDone() || mf.Shape().IsNull()) return fail("fillet", "OCCT could not round the edge again at that radius", first);
    TopTools_ListOfShape args;
    args.Append(cur);
    Handle(BRepTools_History) hF = new BRepTools_History(args, mf);
    H->Merge(hF);
    for (auto& R : rest) {
      if (R.w->chamfer) {
        R.edges = imagesThrough(*hF, R.edges);
        R.f1 = imagesThrough(*hF, R.f1);
        continue;
      }
      for (auto& E : R.edges)
        for (TopTools_ListIteratorOfListOfShape it(mf.Generated(E)); it.More(); it.Next())
          if (it.Value().ShapeType() == TopAbs_FACE) r.reworked[R.w->face].push_back(it.Value());
    }
    cur = mf.Shape();
  }
  if (anyChamfer) {
    BRepFilletAPI_MakeChamfer mc(cur);
    int first = -1;
    for (auto& R : rest) {
      if (!R.w->chamfer) continue;
      if (first < 0) first = R.w->face;
      if (R.edges.size() != 1 || R.f1.size() != 1) return fail("fillet", "the chamfer's edge did not survive the move", R.w->face);
      mc.Add(R.d1, R.d2, TopoDS::Edge(R.edges[0]), TopoDS::Face(R.f1[0]));
    }
    try {
      mc.Build();
    } catch (const Standard_Failure&) {
    }
    if (!mc.IsDone() || mc.Shape().IsNull()) return fail("fillet", "OCCT could not put the chamfer back", first);
    TopTools_ListOfShape args;
    args.Append(cur);
    Handle(BRepTools_History) hC = new BRepTools_History(args, mc);
    H->Merge(hC);
    for (auto& kv : r.reworked) kv.second = imagesThrough(*hC, kv.second);
    for (auto& R : rest) {
      if (!R.w->chamfer) continue;
      for (auto& E : R.edges)
        for (TopTools_ListIteratorOfListOfShape it(mc.Generated(E)); it.More(); it.Next())
          if (it.Value().ShapeType() == TopAbs_FACE) r.reworked[R.w->face].push_back(it.Value());
    }
    cur = mc.Shape();
  }
  r.shape = unwrap(cur);
  r.hist = H;
  return r;
}

// A cylinder pick moved by the annulus between r - |d| and r + |d| over the face's own
// span (its u range around the axis, its v range along it), fused (d > 0) or cut (d < 0):
// the side of r that is already material (fuse) or already empty (cut) is unchanged, so
// the result is the face at r +- d, and no tool face lies on the picked one (OCCT 7.9.3's
// boolean breaks on a cylinder coincident with a thickened copy of itself: the Vortex
// outlet bores). The annulus's end planes are square to the axis: used only where the
// face's neighbours are (stepAt).
OffRun runCylinder(int wid, const std::vector<OffPick>& picks, double d) {
  OffRun r;
  Indexed& in = indexOf(wid);
  TopTools_ListOfShape tools;
  std::vector<std::pair<int, TopoDS_Shape>> targets;  // (pick, the tool's face at the new radius)
  for (auto& p : picks) {
    const TopoDS_Face F = TopoDS::Face(in.f(p.face + 1));
    BRepAdaptor_Surface s(F, false);
    const gp_Cylinder c = s.Cylinder();
    const gp_Ax3 ax = c.Position();
    const double rad = c.Radius();
    double u0 = 0, u1 = 0, v0 = 0, v1 = 0;
    BRepTools::UVBounds(F, u0, u1, v0, v1);
    const double lo = std::max(rad - fabs(d), 0.0), hi = rad + fabs(d);
    const gp_Pnt O = ax.Location();
    const gp_Vec X(ax.XDirection()), Y(ax.YDirection()), Z(ax.Direction());
    auto P = [&](double rr, double vv) {
      gp_Vec w = (X * cos(u0) + Y * sin(u0)) * rr + Z * vv;
      return O.Translated(w);
    };
    BRepBuilderAPI_MakePolygon poly;
    poly.Add(P(lo, v0));
    poly.Add(P(hi, v0));
    poly.Add(P(hi, v1));
    poly.Add(P(lo, v1));
    poly.Close();
    if (!poly.IsDone()) return r.code = "occt", r.detail = "no profile for the cylinder's ring", r;
    BRepBuilderAPI_MakeFace mf(poly.Wire(), Standard_True);
    if (!mf.IsDone()) return r.code = "occt", r.detail = "no profile for the cylinder's ring", r;
    // Increasing u turns about +Z for a direct frame, about -Z for an indirect one.
    gp_Dir axis = ax.Direction();
    if (!ax.Direct()) axis.Reverse();
    const double span = std::min(u1 - u0, 2 * M_PI);
    BRepPrimAPI_MakeRevol rv(mf.Face(), gp_Ax1(O, axis), span);
    rv.Build();
    if (!rv.IsDone()) return r.code = "occt", r.detail = "no ring for the cylinder", r;
    const TopoDS_Shape tool = rv.Shape();
    const double want = p.newRadius;
    TopoDS_Shape target;
    for (TopExp_Explorer ex(tool, TopAbs_FACE); ex.More(); ex.Next()) {
      BRepAdaptor_Surface ts(TopoDS::Face(ex.Current()), false);
      if (ts.GetType() == GeomAbs_Cylinder && fabs(ts.Cylinder().Radius() - want) < 1e-7 * std::max(1.0, want)) target = ex.Current();
    }
    if (target.IsNull()) return r.code = "occt", r.detail = "the ring has no face at the new radius", r;
    tools.Append(tool);
    targets.push_back({p.face, target});
  }
  std::unique_ptr<BRepAlgoAPI_BooleanOperation> bop;
  if (d > 0) bop.reset(new BRepAlgoAPI_Fuse());
  else bop.reset(new BRepAlgoAPI_Cut());
  TopTools_ListOfShape args;
  args.Append(shapeOf(wid));
  bop->SetArguments(args);
  bop->SetTools(tools);
  bop->SetRunParallel(false);
  bop->SetNonDestructive(true);
  bop->SetToFillHistory(true);
  try {
    bop->Build();
  } catch (const Standard_Failure&) {
  }
  if (!bop->IsDone() || bop->HasErrors() || bop->Shape().IsNull()) return r.code = "occt", r.detail = "OCCT's boolean failed", r;
  Handle(BRepTools_History) bh = new BRepTools_History();
  if (!bop->History().IsNull()) bh->Merge(bop->History());
  const Unified uni = unifyChecked(bop->Shape(), bh, true, false);
  r.shape = uni.shape;
  r.hist = uni.hist;
  for (auto& t : targets) {
    std::vector<TopoDS_Shape> g;
    for (TopTools_ListIteratorOfListOfShape it(uni.hist->Modified(t.second)); it.More(); it.Next()) g.push_back(it.Value());
    for (TopTools_ListIteratorOfListOfShape it(uni.hist->Generated(t.second)); it.More(); it.Next()) g.push_back(it.Value());
    if (g.empty() && !uni.hist->IsRemoved(t.second)) g.push_back(t.second);
    r.reworked[t.first] = g;
  }
  return r;
}

// A stored candidate result: its id, history against `sid` (every face `same` / `modified`
// as it went; a reworked face's new faces `modified` from it), `moved` per pick.
JV candidateJson(int sid, int wid, const std::vector<OffPick>& picks, const OffRun& run, const char* method) {
  const int id = putShape(run.shape);
  Indexed& out = indexOf(id);
  Indexed& in = indexOf(wid);
  HistBuilder hb;
  hb.addInput(wid, *run.hist, out, sid);
  std::set<int> kept;
  for (auto& kv : run.reworked) {
    std::vector<int> m;
    for (auto& g : kv.second) {
      const int k = out.f.FindIndex(g);
      if (k && std::find(m.begin(), m.end(), k - 1) == m.end()) m.push_back(k - 1);
    }
    for (int k : m) hb.add(hb.faceFrom, k, HistBuilder::from(sid, "face", kv.first, "modified"));
    if (!m.empty()) kept.insert(kv.first);
  }
  if (!kept.empty()) {
    JV rest = JV::arr();
    for (auto& dj : hb.deleted.items()) {
      const JV* f = dj.get("face");
      if (f && kept.count((int)f->num())) continue;
      rest.push(dj);
    }
    hb.deleted = rest;
  }
  JV moved = JV::arr();
  for (auto& p : picks) {
    std::vector<int> m;
    auto it = run.reworked.find(p.face);
    if (it != run.reworked.end()) {
      for (auto& g : it->second) {
        const int k = out.f.FindIndex(g);
        if (k && std::find(m.begin(), m.end(), k - 1) == m.end()) m.push_back(k - 1);
      }
    } else {
      m = facesThrough(*run.hist, in.f(p.face + 1), out);
    }
    moved.push(m.empty() ? -1 : m.front());
  }
  JV r = JV::obj();
  r.set("id", id);
  r.set("solids", countOf(run.shape, TopAbs_SOLID));
  r.set("moved", std::move(moved));
  r.set("method", method);
  r.set("history", hb.json());
  r.set("faces", out.f.Extent());
  r.set("valid", true);
  return r;
}

// The volume a pick's move should add (> 0) or remove (< 0): area x d, with the
// curvature terms where the face's growth is known exactly (a cylinder: A d (1 + k d / 2),
// a sphere: A d (1 + k d + k^2 d^2 / 3), k = +-1/r), and a fillet's corner region (between
// the arc and the sharp corner, (tan(phi/2) - phi/2) r^2 per unit length) at its new radius.
double expectedDV(const OffPick& p, double d) {
  const double A = p.area;
  if (p.blend) {
    const double phi = p.span;
    if (!(phi > 1e-6) || !(p.radius > 0)) return A * d;
    const double c = tan(phi / 2) - phi / 2;
    const double L = A / (p.radius * phi);
    const double sgn = p.convex ? -1 : 1;
    return sgn * c * (p.newRadius * p.newRadius - p.radius * p.radius) * L;
  }
  if (p.type == "cylinder" && p.radius > 0) {
    const double k = (p.convex ? 1 : -1) / p.radius;
    return A * d * (1 + k * d / 2);
  }
  if (p.type == "sphere" && p.radius > 0) {
    const double k = (p.convex ? 1 : -1) / p.radius;
    return A * d * (1 + k * d + k * k * d * d / 3);
  }
  return A * d;
}

// Why a candidate is not accepted (empty: it is). `code`: empty (nothing left), invalid
// (BRepCheck, `detail`), self (cuts through itself), gone (a picked face is not in the
// result), vanish (a face next to a picked one shrinks to nothing), lost (another face is
// gone), split (adding material made separate solids), volume (the volume moves the wrong
// way, or by far less or far more than the faces' move: `dv`, `expected`).
struct Verdict {
  std::string code, detail;
  int face = -1;
  double dv = 0, expected = 0;
  int solids = 0;
  bool ok() const { return code.empty(); }
};

// The accept rule (fix round 1): every method's result is checked the same way before it
// is taken. Volume: within 0.5x - 2x of the expected change. The curvature terms make the
// expectation exact for faces whose neighbours are square to them (plates, bores, bosses,
// caps: ratio 1); a sloping neighbour that is extended or trimmed moves it by its own
// slope (the review's trapezoid: 0.67 at +40, 1.16 at -19); a hole breaking out of its
// plate removes less than the full ring (0.96 at -12). The broken results the review found
// were at 0.000, -0.000003 and 0.0008 (the thickened fillet at -40, the Vortex's main
// cylinder and a B-spline face at -1).
Verdict acceptResult(int sid, const std::vector<OffPick>& picks, const std::set<int>& carried, const std::vector<int>& tangent, double d, const JV& cand, bool selfCheck, double v0) {
  Verdict v;
  const int rid = (int)cand.get("id")->num();
  const TopoDS_Shape& S1 = shapeOf(rid);
  if (S1.IsNull() || countOf(S1, TopAbs_FACE) == 0 || countOf(S1, TopAbs_SOLID) == 0) {
    v.code = "empty";
    return v;
  }
  Validity val = analyse(S1);
  if (!val.valid) {
    v.code = "invalid";
    v.detail = val.reason;
    return v;
  }
  Indexed& out = indexOf(rid);
  Indexed& in = indexOf(sid);
  // Input face -> result faces, from the candidate's history.
  std::vector<std::vector<int>> img(in.f.Extent());
  for (auto& e : cand.get("history")->get("faces")->items()) {
    const int o = (int)e.get("out")->num();
    for (auto& s : e.get("from")->items()) {
      const JV* sh = s.get("shape");
      const JV* f = s.get("face");
      if (!sh || !f || (int)sh->num() != sid) continue;
      const int i = (int)f->num();
      if (i >= 0 && i < (int)img.size()) img[i].push_back(o);
    }
  }
  auto areaOf = [&](const std::vector<int>& os) {
    double a = 0;
    for (int o : os) {
      GProp_GProps fp;
      BRepGProp::SurfaceProperties(out.f(o + 1), fp);
      a += fabs(fp.Mass());
    }
    return a;
  };
  std::set<int> picked;
  for (auto& p : picks) picked.insert(p.face);
  const JV& moved = *cand.get("moved");
  for (size_t i = 0; i < picks.size(); ++i) {
    const int m = (int)moved[i].num();
    if (m < 0 || !(areaOf({m}) > 1e-6)) {
      v.code = "gone";
      v.face = picks[i].face;
      return v;
    }
  }
  std::set<int> nearPicks;
  for (auto& p : picks)
    for (int j : neighboursOf(sid, p.face)) nearPicks.insert(j);
  for (int i = 0; i < in.f.Extent(); ++i) {
    if (picked.count(i) || carried.count(i)) continue;
    if (!(areaOf(img[i]) > 1e-6)) {
      v.code = nearPicks.count(i) ? "vanish" : "lost";
      v.face = i;
      return v;
    }
  }
  v.solids = countOf(S1, TopAbs_SOLID);
  if (d > 0 && v.solids > countOf(shapeOf(sid), TopAbs_SOLID)) {
    v.code = "split";
    return v;
  }
  GProp_GProps gp;
  BRepGProp::VolumeProperties(S1, gp);
  v.dv = gp.Mass() - v0;
  double E = 0;
  for (auto& p : picks) E += expectedDV(p, d);
  for (int t : tangent) {
    OffPick tp = describeOffPick(sid, t, d);
    E += expectedDV(tp, d);
  }
  v.expected = E;
  if (fabs(E) > 1e-9 * std::max(1.0, fabs(v0))) {
    const double ratio = v.dv / E;
    if (!(ratio >= 0.5 && ratio <= 2.0)) {
      v.code = "volume";
      return v;
    }
  }
  if (selfCheck) {
    BRepAlgoAPI_Check chk(S1, Standard_False, Standard_True);
    if (!chk.IsValid()) {
      v.code = "self";
      return v;
    }
  }
  return v;
}

// A neighbour of a picked face that is not square to it (its normal off the picked face's
// tangent plane by more than ~1.1 degrees at the shared edge), or -1. Moving the face alone
// along its normal (a prism, a thickened face, a cylinder's ring) leaves a step or a groove
// there (the review's cone: a mushroom), so those methods are not used.
int stepAt(int sid, const std::vector<OffPick>& picks) {
  Indexed& ix = indexOf(sid);
  const auto& ef = edgeFacesOf(sid);
  std::set<int> picked;
  for (auto& p : picks) picked.insert(p.face);
  for (auto& p : picks) {
    const TopoDS_Face F = TopoDS::Face(ix.f(p.face + 1));
    for (TopExp_Explorer ex(F, TopAbs_EDGE); ex.More(); ex.Next()) {
      const TopoDS_Edge& E = TopoDS::Edge(ex.Current());
      if (BRep_Tool::Degenerated(E) || BRep_Tool::IsClosed(E, F)) continue;
      const int k = ef.FindIndex(E);
      if (!k) continue;
      for (TopTools_ListIteratorOfListOfShape it(ef(k)); it.More(); it.Next()) {
        if (it.Value().IsSame(F)) continue;
        const int j = ix.f.FindIndex(it.Value()) - 1;
        if (j < 0 || picked.count(j)) continue;
        double worst = 0;
        for (double t : {0.2, 0.5, 0.8}) {
          gp_Dir a, b;
          if (normalOnEdge(F, E, t, a) && normalOnEdge(TopoDS::Face(it.Value()), E, t, b)) worst = std::max(worst, fabs(a.Dot(b)));
        }
        if (worst > 0.02) return j;
      }
    }
  }
  return -1;
}

JV aboutJson(const OffPick& p) {
  JV o = JV::obj();
  o.set("face", p.face);
  o.set("type", p.type);
  o.set("role", p.role);
  o.set("convex", p.convex);
  if (p.hasRadius) {
    o.set("radius", p.radius);
    o.set("new_radius", p.newRadius);
  }
  JV t = JV::arr();
  for (int k : p.tangent) t.push(k);
  o.set("tangent", std::move(t));
  return o;
}

JV pressPullRun(int sid, const std::vector<int>& fidx, double d, double fuzzy, const std::string& glue, bool unifyOn, bool check);

// offset_faces {id, faces, d, check?, self_check?, diagnose?, carry?, chain?}: see the API 6
// notes above. `carry`: faces (a Chamfer feature's, by name in the document) to take off
// and put back at their own size when they are next to a picked face; fillets next to a
// picked face are found by their shape. `chain` (fix round 1): when the offset is refused,
// the next method: a cylinder pick's ring (runCylinder), then the faces' prisms or
// thickened faces (press_pull); a method that would leave a step (stepAt) is not used.
// Every result goes through acceptResult. Success: {id, valid, faces, solids, history,
// moved, about, tangent, method: offset / refillet / offset+refillet / cylinder / prism /
// thicken}. A refusal is not an error: {refused: {code, words?, detail?, face?, dv?,
// expected?, d?}, about, max_ok?}: the most telling reason of the methods tried (radius,
// empty, gone, lost, split, volume, vanish, self, invalid, fillet, step, occt). With
// diagnose:true, `max_ok`: the largest |d| (same sign) that some method takes, by
// bisection on fresh work copies (at most 10 tries), or null.
JV opOffsetFaces(const JV& q) {
  const int sid = idParam(q.req("id"), "id");
  const JV& jf = q.req("faces");
  if (!jf.isArr() || jf.size() == 0) throw InputError("offset_faces needs at least one face");
  const double d = q.num("d");
  if (!(fabs(d) > 1e-9)) throw InputError("offset_faces distance must not be 0");
  const bool selfCheck = q.boolean("self_check", true);
  const bool diagnose = q.boolean("diagnose", false);
  const bool chain = q.boolean("chain", false);
  std::vector<int> fidx;
  for (auto& f : jf.items()) {
    faceAt(sid, f);
    const int i = (int)f.num();
    if (std::find(fidx.begin(), fidx.end(), i) != fidx.end()) throw InputError("face " + std::to_string(i) + " is given twice");
    fidx.push_back(i);
  }
  std::set<int> picked(fidx.begin(), fidx.end());
  std::vector<int> explicitCarry;
  if (q.has("carry"))
    for (auto& f : q.req("carry").items()) {
      faceAt(sid, f);
      explicitCarry.push_back((int)f.num());
    }
  const double t0 = nowMs();
  Indexed& ix = indexOf(sid);
  auto describeAll = [&](double dd) {
    std::vector<OffPick> ps;
    for (int i : fidx) ps.push_back(describeOffPick(sid, i, dd));
    return ps;
  };
  std::vector<OffPick> picks = describeAll(d);
  // Faces carried: fillets tangent to a non-fillet pick (by their shape), and the chamfers
  // named in `carry` that touch a pick. A flat pick tangent to anything else is not offset
  // (OCCT would move that face with it: the walls of a rounded box top).
  std::map<int, Rework> carried;
  bool flatBlocked = false;
  for (auto& p : picks) {
    if (p.blend) continue;
    for (int g : tangentNeighbours(sid, TopoDS::Face(ix.f(p.face + 1)))) {
      if (picked.count(g) || carried.count(g)) continue;
      OffPick n = describeOffPick(sid, g, 0);
      if (n.blend) {
        Rework w;
        w.face = g;
        w.r = n.radius;
        carried[g] = w;
      } else if (p.role == "flat") {
        flatBlocked = true;
      }
    }
    for (int c : explicitCarry) {
      if (picked.count(c) || carried.count(c)) continue;
      if (!neighboursOf(sid, p.face).count(c)) continue;
      BRepAdaptor_Surface cs(TopoDS::Face(ix.f(c + 1)), false);
      if (cs.GetType() != GeomAbs_Plane) continue;
      Rework w;
      w.face = c;
      w.chamfer = true;
      carried[c] = w;
    }
  }
  std::set<int> carriedSet;
  for (auto& kv : carried) carriedSet.insert(kv.first);
  // Faces OCCT moves along with a picked one: tangent to it, transitively (carried fillets stop it).
  for (auto& p : picks) {
    if (p.blend) continue;
    std::set<int> seen = {p.face};
    std::vector<int> todo = {p.face};
    while (!todo.empty()) {
      const int f = todo.back();
      todo.pop_back();
      for (int g : tangentNeighbours(sid, TopoDS::Face(ix.f(f + 1)))) {
        if (seen.count(g) || carriedSet.count(g)) continue;
        seen.insert(g);
        todo.push_back(g);
        if (!picked.count(g)) p.tangent.push_back(g);
      }
    }
    std::sort(p.tangent.begin(), p.tangent.end());
  }
  JV about = JV::arr();
  for (auto& p : picks) about.push(aboutJson(p));
  std::vector<int> tangentAll;
  for (auto& p : picks)
    for (int k : p.tangent)
      if (std::find(tangentAll.begin(), tangentAll.end(), k) == tangentAll.end()) tangentAll.push_back(k);
  GProp_GProps g0;
  BRepGProp::VolumeProperties(shapeOf(sid), g0);
  const double v0 = g0.Mass();
  const double t1 = nowMs();

  static const char* kRank[] = {"radius", "empty", "gone", "lost", "split", "volume", "vanish", "self", "invalid", "fillet", "step", "occt"};
  auto rankOf = [](const std::string& c) {
    for (int i = 0; i < 12; ++i)
      if (c == kRank[i]) return i;
    return 12;
  };
  struct Why {
    std::string code, words, detail;
    int face = -1;
    double dv = 0, expected = 0;
  };
  // Every method in turn for distance dd; the accepted candidate (stored), or null and the
  // most telling reason.
  auto attempt = [&](double dd, Why* why, bool keep) -> JV {
    std::vector<OffPick> ps = describeAll(dd);
    for (size_t i = 0; i < ps.size(); ++i) ps[i].tangent = picks[i].tangent;
    Why best;
    best.code = "";
    auto note = [&](const Why& w) {
      if (best.code.empty() || rankOf(w.code) < rankOf(best.code)) best = w;
    };
    for (auto& p : ps)
      if (fabs(dd) >= p.limit * (1 - 1e-9)) {
        Why w;
        w.code = "radius";
        w.words = p.limitWords;
        w.face = p.face;
        if (why) *why = w;
        return JV();
      }
    std::vector<Rework> rw;
    for (auto& p : ps)
      if (p.blend) {
        Rework w;
        w.face = p.face;
        w.picked = true;
        w.r = p.newRadius;
        rw.push_back(w);
      }
    for (auto& kv : carried) rw.push_back(kv.second);
    auto judge = [&](JV cand, const std::vector<int>& tangent) -> JV {
      Verdict v = acceptResult(sid, ps, carriedSet, tangent, dd, cand, selfCheck, v0);
      if (v.ok()) {
        if (!keep) g_store.erase((int)cand.get("id")->num());
        return cand;
      }
      g_store.erase((int)cand.get("id")->num());
      Why w;
      w.code = v.code;
      w.detail = v.detail;
      w.face = v.face;
      w.dv = v.dv;
      w.expected = v.expected;
      note(w);
      return JV();
    };
    // 1. The true offset (fillets re-rounded, carried faces put back).
    if (!flatBlocked) {
      try {
        WorkCopies wc({sid});
        OffRun run = runOffset(wc.id(0), ps, rw, dd);
        if (run.ok()) {
          bool anyBlend = false, anyPlain = false;
          for (auto& p : ps) (p.blend ? anyBlend : anyPlain) = true;
          JV c = judge(candidateJson(sid, wc.id(0), ps, run, anyBlend && anyPlain ? "offset+refillet" : anyBlend ? "refillet" : "offset"), tangentAll);
          if (!c.isNull()) return c;
        } else {
          Why w;
          w.code = run.code;
          w.words = run.words;
          w.detail = run.detail;
          w.face = run.face;
          note(w);
        }
      } catch (const Standard_Failure& e) {
        Why w;
        w.code = "occt";
        w.detail = std::string("OCCT's offset stopped: ") + (e.GetMessageString() ? e.GetMessageString() : "an exception");
        note(w);
      }
    }
    if (chain) {
      const int step = stepAt(sid, ps);
      if (step >= 0) {
        Why w;
        w.code = "step";
        w.face = step;
        note(w);
      } else {
        bool cyl = true;
        for (auto& p : ps) cyl = cyl && !p.blend && p.type == "cylinder";
        // 2. A cylinder's ring.
        if (cyl) {
          try {
            WorkCopies wc({sid});
            OffRun run = runCylinder(wc.id(0), ps, dd);
            if (run.ok()) {
              JV c = judge(candidateJson(sid, wc.id(0), ps, run, "cylinder"), {});
              if (!c.isNull()) return c;
            } else {
              Why w;
              w.code = run.code;
              w.detail = run.detail;
              note(w);
            }
          } catch (const Standard_Failure&) {
            Why w;
            w.code = "occt";
            note(w);
          }
        }
        // 3. The faces' prisms (flat) or thickened faces (curved).
        try {
          JV c = pressPullRun(sid, fidx, dd, 0, "off", true, true);
          bool flat = true;
          for (auto& p : ps) flat = flat && p.type == "plane";
          c.set("method", flat ? "prism" : "thicken");
          if (c.get("empty") && c.get("empty")->boolean()) {
            g_store.erase((int)c.get("id")->num());
            Why w;
            w.code = "empty";
            note(w);
          } else {
            JV ok = judge(c, {});
            if (!ok.isNull()) return ok;
          }
        } catch (const OcctError& e) {
          Why w;
          const std::string m = e.what();
          w.code = m.find("whole body") != std::string::npos ? "empty" : "occt";
          if (w.code == "occt") w.detail = m;
          note(w);
        } catch (const Standard_Failure&) {
          Why w;
          w.code = "occt";
          note(w);
        }
      }
    }
    if (why) *why = best;
    return JV();
  };

  Why why;
  JV got = attempt(d, &why, true);
  const double t2 = nowMs();
  if (!got.isNull()) {
    const std::string method = got.get("method")->str();
    got.set("about", about);
    JV tangent = JV::arr();
    if (method == "offset" || method == "offset+refillet" || method == "refillet")
      for (int k : tangentAll) tangent.push(k);
    got.set("tangent", std::move(tangent));
    JV ca = JV::arr();
    for (int c : carriedSet) ca.push(c);
    got.set("carried", std::move(ca));
    JV tm = JV::obj();
    tm.set("describe_ms", t1 - t0);
    tm.set("build_ms", t2 - t1);
    got.set("timings", std::move(tm));
    return got;
  }
  JV r = JV::obj();
  JV rf = JV::obj();
  rf.set("code", why.code.empty() ? "occt" : why.code);
  if (!why.words.empty()) rf.set("words", why.words);
  if (!why.detail.empty()) rf.set("detail", why.detail);
  if (why.face >= 0) rf.set("face", why.face);
  if (why.code == "volume") {
    rf.set("dv", why.dv);
    rf.set("expected", why.expected);
  }
  rf.set("d", d);
  r.set("refused", std::move(rf));
  r.set("about", about);
  if (diagnose) {
    const double sgn = d > 0 ? 1 : -1;
    double hi = fabs(d);
    for (auto& p : picks) hi = std::min(hi, p.limit * (1 - 1e-3));
    auto works = [&](double a) { return !attempt(sgn * a, nullptr, false).isNull(); };
    double good = 0, bad = fabs(d);
    int runs = 0;
    if (hi < fabs(d)) {
      ++runs;
      if (works(hi)) good = hi;
      else bad = hi;
    }
    if (good == 0)
      for (double f : {0.5, 0.25, 0.1, 0.02}) {
        ++runs;
        if (works(bad * f)) {
          good = bad * f;
          break;
        }
        bad = bad * f;
      }
    while (good > 0 && runs < 10 && (bad - good) > 1e-3 * bad) {
      const double mid = 0.5 * (good + bad);
      ++runs;
      if (works(mid)) good = mid;
      else bad = mid;
    }
    r.set("max_ok", good > 0 ? JV(good) : JV());
    r.set("diagnose_runs", runs);
  }
  JV tm = JV::obj();
  tm.set("describe_ms", t1 - t0);
  tm.set("total_ms", nowMs() - t0);
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

// P4b (R1): a B-spline sketch curve, {degree, poles, knots, mults, weights?} in sketch u/v:
// Geom2d_BSplineCurve(poles[, weights], knots, mults, degree, non-periodic). Refusals are
// InputError "bspline <id>: <reason>".
Handle(Geom2d_BSplineCurve) bspline2d(const JV& c, const std::string& id) {
  auto bad = [&](const std::string& why) { return InputError("bspline " + id + ": " + why); };
  const JV& jp = c.req("poles");
  const JV& jk = c.req("knots");
  const JV& jm = c.req("mults");
  if (!jp.isArr() || !jk.isArr() || !jm.isArr()) throw bad("poles, knots and mults must be arrays");
  const int deg = (int)c.num("degree");
  if (deg < 1 || deg > 8 || (double)deg != c.num("degree")) throw bad("the degree must be a whole number from 1 to 8");
  const int np = (int)jp.size(), nk = (int)jk.size();
  if (np < deg + 1) throw bad("a degree " + std::to_string(deg) + " spline needs at least " + std::to_string(deg + 1) + " poles");
  if (nk < 2 || (int)jm.size() != nk) throw bad("knots and mults must have the same length (at least 2)");
  TColgp_Array1OfPnt2d poles(1, np);
  for (int i = 0; i < np; ++i) poles.SetValue(i + 1, uv(jp[i]));
  TColStd_Array1OfReal knots(1, nk);
  TColStd_Array1OfInteger mults(1, nk);
  int sum = 0;
  for (int i = 0; i < nk; ++i) {
    knots.SetValue(i + 1, jk[i].num());
    const double m = jm[i].num();
    if (m < 1 || m > deg + 1 || (double)(int)m != m) throw bad("each multiplicity must be a whole number from 1 to degree + 1");
    if ((i == 0 || i == nk - 1) ? false : m > deg) throw bad("an inner knot's multiplicity must be at most the degree");
    mults.SetValue(i + 1, (int)m);
    sum += (int)m;
    if (i > 0 && !(jk[i].num() > jk[i - 1].num())) throw bad("the knots must increase strictly");
  }
  if (sum != np + deg + 1) throw bad("the multiplicities must add up to poles + degree + 1 (" + std::to_string(np + deg + 1) + ")");
  try {
    if (const JV* jw = c.get("weights")) {
      if (!jw->isNull()) {
        if (!jw->isArr() || (int)jw->size() != np) throw bad("weights must have one value per pole");
        TColStd_Array1OfReal w(1, np);
        for (int i = 0; i < np; ++i) {
          if (!((*jw)[i].num() > 0)) throw bad("weights must be > 0");
          w.SetValue(i + 1, (*jw)[i].num());
        }
        return new Geom2d_BSplineCurve(poles, w, knots, mults, deg, Standard_False);
      }
    }
    return new Geom2d_BSplineCurve(poles, knots, mults, deg, Standard_False);
  } catch (const Standard_Failure& e) {
    throw bad(failureText(e));
  }
}

// The same B-spline on a plane frame (an affine map keeps a B-spline a B-spline).
Handle(Geom_BSplineCurve) bsplineOnPlane(const Handle(Geom2d_BSplineCurve)& b, const gp_Ax3& ax) {
  const int n = b->NbPoles();
  TColgp_Array1OfPnt poles(1, n);
  for (int i = 1; i <= n; ++i) {
    const gp_Pnt2d q = b->Pole(i);
    poles.SetValue(i, gp_Pnt(ax.Location().XYZ() + ax.XDirection().XYZ() * q.X() + ax.YDirection().XYZ() * q.Y()));
  }
  TColStd_Array1OfReal knots(1, b->NbKnots());
  TColStd_Array1OfInteger mults(1, b->NbKnots());
  b->Knots(knots);
  b->Multiplicities(mults);
  if (b->IsRational()) {
    TColStd_Array1OfReal w(1, n);
    b->Weights(w);
    return new Geom_BSplineCurve(poles, w, knots, mults, b->Degree(), Standard_False);
  }
  return new Geom_BSplineCurve(poles, knots, mults, b->Degree(), Standard_False);
}

struct SkCurve {
  std::string id, kind;          // line | arc | circle | bspline (P4b)
  gp_Pnt2d a, b, c;              // line ends; arc/circle centre (an arc's ends in a, b); a B-spline's ends
  double r = 0, a0 = 0, a1 = 0;  // arcs: radians from xdir
  bool ccw = true;
  double sweep = 0;              // arcs: radians, > 0, in the arc's own sense
  Handle(Geom2d_BSplineCurve) bs;  // bspline
  bool closed = false;             // bspline: its ends meet (a lone closed one is one loop)
  double sense() const { return kind == "arc" && !ccw ? -1.0 : 1.0; }
};

// The parameter of the point of B-spline `c` nearest to p (its ends when the projection fails).
double bsParam(const SkCurve& c, const gp_Pnt2d& p) {
  const double f = c.bs->FirstParameter(), l = c.bs->LastParameter();
  double best = p.Distance(c.a) <= p.Distance(c.b) ? f : l;
  double bd = std::min(p.Distance(c.a), p.Distance(c.b));
  try {
    Geom2dAPI_ProjectPointOnCurve pr(p, c.bs, f, l);
    for (int i = 1; i <= pr.NbPoints(); ++i)
      if (pr.Distance(i) < bd) {
        bd = pr.Distance(i);
        best = pr.Parameter(i);
      }
  } catch (const Standard_Failure&) {
  }
  return best;
}

double bsDistance(const SkCurve& c, const gp_Pnt2d& p) { return c.bs->Value(bsParam(c, p)).Distance(p); }

// Does the B-spline run forward (its own parameter growing) from q0 to q1 (close together on it)?
bool bsForward(const SkCurve& c, const gp_Pnt2d& q0, const gp_Pnt2d& q1) {
  const double u0 = bsParam(c, q0), u1 = bsParam(c, q1);
  double d = u1 - u0;
  if (c.closed) {
    const double per = c.bs->LastParameter() - c.bs->FirstParameter();
    if (d > per / 2) d -= per;
    else if (d < -per / 2) d += per;
  }
  return d > 0;
}

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
  if (c.kind == "bspline") return bsDistance(c, p) <= eps;
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

// P4b (R5): the 2D curves (pcurves) of B-spline edges on a sketch's planar faces made exact. The
// splitter projects a B-spline onto the plane by approximation (ProjLib), which left a closed spline
// region's area 0.008 % off and, once its prism was fused with another, its volume 0.04 % off. A
// B-spline lying in a plane IS a B-spline in the plane's own coordinates (an affine map of its poles),
// so the pcurve is replaced by that one, over the same parameter range.
void exactPlanePCurves(const TopoDS_Shape& shape, const gp_Ax3& ax) {
  BRep_Builder bb;
  const gp_Pnt O = ax.Location();
  const gp_Vec X(ax.XDirection().XYZ()), Y(ax.YDirection().XYZ());
  for (TopExp_Explorer fx(shape, TopAbs_FACE); fx.More(); fx.Next()) {
    const TopoDS_Face F = TopoDS::Face(fx.Current());
    TopLoc_Location sl;
    Handle(Geom_Plane) pl = Handle(Geom_Plane)::DownCast(BRep_Tool::Surface(F, sl));
    if (pl.IsNull()) continue;
    // The face's plane must be the sketch's own frame (the cover face is made on gp_Pln(ax)).
    const gp_Ax3 fa = pl->Position().Transformed(sl.Transformation());
    if (fa.Location().Distance(O) > 1e-9 || !fa.XDirection().IsParallel(ax.XDirection(), 1e-12) || !fa.YDirection().IsParallel(ax.YDirection(), 1e-12)) continue;
    const double sx = fa.XDirection().Dot(ax.XDirection()) > 0 ? 1.0 : -1.0;
    const double sy = fa.YDirection().Dot(ax.YDirection()) > 0 ? 1.0 : -1.0;
    for (TopExp_Explorer ex(F, TopAbs_EDGE); ex.More(); ex.Next()) {
      const TopoDS_Edge E = TopoDS::Edge(ex.Current());
      TopLoc_Location el;
      double f, l;
      Handle(Geom_Curve) c = BRep_Tool::Curve(E, el, f, l);
      if (c.IsNull()) continue;
      Handle(Geom_TrimmedCurve) tc = Handle(Geom_TrimmedCurve)::DownCast(c);
      if (!tc.IsNull()) c = tc->BasisCurve();
      Handle(Geom_BSplineCurve) b = Handle(Geom_BSplineCurve)::DownCast(c);
      if (b.IsNull()) continue;
      if (!el.IsIdentity()) b = Handle(Geom_BSplineCurve)::DownCast(b->Transformed(el.Transformation()));
      const int n = b->NbPoles();
      TColgp_Array1OfPnt2d poles(1, n);
      bool flat = true;
      for (int i = 1; i <= n; ++i) {
        const gp_Vec v(O, b->Pole(i));
        if (fabs(v.Dot(gp_Vec(ax.Direction().XYZ()))) > 1e-7 * std::max(1.0, v.Magnitude())) flat = false;
        poles.SetValue(i, gp_Pnt2d(sx * v.Dot(X), sy * v.Dot(Y)));
      }
      if (!flat) continue;
      TColStd_Array1OfReal knots(1, b->NbKnots());
      TColStd_Array1OfInteger mults(1, b->NbKnots());
      b->Knots(knots);
      b->Multiplicities(mults);
      Handle(Geom2d_BSplineCurve) c2;
      try {
        if (b->IsRational()) {
          TColStd_Array1OfReal w(1, n);
          b->Weights(w);
          c2 = new Geom2d_BSplineCurve(poles, w, knots, mults, b->Degree(), b->IsPeriodic());
        } else {
          c2 = new Geom2d_BSplineCurve(poles, knots, mults, b->Degree(), b->IsPeriodic());
        }
      } catch (const Standard_Failure&) {
        continue;
      }
      // Closed edges on the face (a lone closed spline) keep one pcurve: UpdateEdge with one curve.
      bb.UpdateEdge(E, c2, F, BRep_Tool::Tolerance(E));
      bb.Range(E, F, f, l);
    }
  }
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
    } else if (kind == "bspline") {
      s.bs = bspline2d(c, id);
      s.a = s.bs->StartPoint();
      s.b = s.bs->EndPoint();
      for (int i = 1; i <= s.bs->NbPoles(); ++i) extent = std::max({extent, fabs(s.bs->Pole(i).X()), fabs(s.bs->Pole(i).Y())});
      const std::string pa = c.str("pa", ""), pb = c.str("pb", "");
      if (!pa.empty()) R->points.emplace_back(pa, s.a);
      if (!pb.empty() && pb != pa) R->points.emplace_back(pb, s.b);
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
    if (s.kind == "bspline") {
      Geom2dAdaptor_Curve ac(s.bs);
      if (GCPnts_AbscissaPoint::Length(ac) <= tol) throw InputError("bspline " + s.id + ": the curve is shorter than the tolerance");
      s.closed = s.a.Distance(s.b) <= tol;
      continue;
    }
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
    if (s.kind == "bspline") {
      BRepBuilderAPI_MakeEdge me(bsplineOnPlane(s.bs, R->ax));
      if (!me.IsDone()) throw InputError("bspline " + s.id + ": the curve cannot be built");
      e = me.Edge();
      for (int i = 1; i <= s.bs->NbPoles(); ++i) grow(s.bs->Pole(i).X(), s.bs->Pole(i).Y());
    } else if (s.kind == "line") {
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
  exactPlanePCurves(R->split, R->ax);
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
      if (E.kind == "bspline") fwd = bsForward(E, q0, q1);
      else if (E.kind == "line") fwd = lineParam(E, q1) > lineParam(E, q0);
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
  // P4b (R1): crossings of a pair with a B-spline are numbered along the B-spline's own
  // parameter (the first of the pair that is one): rank of each such vertex in its pair.
  std::map<int, int> bsOrdinal;
  {
    std::map<std::pair<int, int>, std::vector<std::pair<double, int>>> byPair;
    for (int v = 0; v < nv; ++v) {
      vuv[v] = R->to2(BRep_Tool::Pnt(TopoDS::Vertex(R->verts(v + 1))));
      auto own = R->vertOwners[v];
      std::sort(own.begin(), own.end());
      if (own.size() < 2) continue;
      const SkCurve& E = R->curves[own[0]];
      const SkCurve& F = R->curves[own[1]];
      if (E.kind != "bspline" && F.kind != "bspline") continue;
      const SkCurve& B = E.kind == "bspline" ? E : F;
      byPair[{own[0], own[1]}].emplace_back(bsParam(B, vuv[v]), v);
    }
    for (auto& kv : byPair) {
      std::sort(kv.second.begin(), kv.second.end());
      for (size_t i = 0; i < kv.second.size(); ++i) bsOrdinal[kv.second[i].second] = (int)i;
    }
  }
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
      const auto bo = bsOrdinal.find(v);
      const int ord = bo != bsOrdinal.end() ? bo->second : crossingOrdinal(E, F, vuv[v], tol);
      R->vertName[v] = "x:" + E.id + "|" + F.id + "#" + std::to_string(ord);
    } else if (!own.empty()) {
      const SkCurve& E = R->curves[own[0]];
      int k = 0;
      if (E.kind == "line") k = lineParam(E, vuv[v]) > 0.5 ? 1 : 0;
      else if (E.kind == "arc" || (E.kind == "bspline" && !E.closed)) k = E.b.Distance(vuv[v]) < E.a.Distance(vuv[v]) ? 1 : 0;
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
    if (E.kind == "bspline" && !E.closed) {
      ab = bsParam(E, vuv[A]) < bsParam(E, vuv[B]);
    } else if (E.kind == "bspline") {
      // Closed: from A along the curve's own sense, a point inside the chain comes before B.
      BRepAdaptor_Curve c(TopoDS::Edge(R->pieces(sg.pieces[0] + 1)));
      const gp_Pnt2d m = edgePoint(*R, c, 0.5);
      const double f = E.bs->FirstParameter(), per = E.bs->LastParameter() - f;
      auto from = [&](const gp_Pnt2d& p) {
        double d = fmod(bsParam(E, p) - bsParam(E, vuv[A]), per);
        return d < 0 ? d + per : d;
      };
      ab = from(m) < from(vuv[B]);
    } else if (E.kind == "line") {
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
        if (c.GetType() != GeomAbs_Line && c.GetType() != GeomAbs_Circle)
          for (int k = 1; k < 64; ++k) add(edgePoint(*R, c, k / 64.0));
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
    if (sketchSplineFaces(rg.face, true)) BRepGProp::SurfaceProperties(rg.face, g, 1e-9);
    else BRepGProp::SurfaceProperties(rg.face, g);
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

// Sketch regions selected by key, merged where they touch (UnifySameDomain: faces on;
// edges merged only across a curve's own seam, so each side stays one sub-segment), one
// Profile per merged face with its edges tagged by their sub-segment token. The regions
// are derived again from the curves (as sketch_regions) and a key that is not there is
// refused ("region not found: <key>"). Shared by extrude_regions, revolve_regions,
// sweep_regions and loft_regions (API 4); `what` names the op in messages.
struct RegionProfiles {
  std::unique_ptr<SketchRegionSet> R;
  std::vector<std::shared_ptr<Profile>> profiles;  // one per merged face
  std::vector<TopoDS_Face> faces;
  std::vector<std::vector<std::string>> keysOf;  // the region keys of each merged face
  std::vector<int> faceOfSel;                     // the merged face of each selected key
  std::vector<std::string> selKeys;
};

RegionProfiles regionProfiles(const JV& q, const std::string& what) {
  RegionProfiles out;
  const JV& jk = q.req("regions");
  if (!jk.isArr() || jk.size() == 0) throw InputError(what + "_regions needs at least one region");
  out.R = computeRegions(q);
  SketchRegionSet* R = out.R.get();
  std::map<std::string, int> byKey;
  for (size_t i = 0; i < R->regions.size(); ++i) byKey[R->regions[i].key] = (int)i;
  std::vector<int> sel;
  for (auto& k : jk.items()) {
    const std::string key = k.str();
    auto it = byKey.find(key);
    if (it == byKey.end()) throw InputError("region not found: " + key);
    if (std::find(sel.begin(), sel.end(), it->second) != sel.end()) continue;
    sel.push_back(it->second);
    out.selKeys.push_back(key);
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
  out.keysOf.assign(mfaces.Extent(), {});
  out.faceOfSel.assign(sel.size(), -1);
  for (size_t s = 0; s < sel.size(); ++s) {
    const TopoDS_Face& f = R->regions[sel[s]].face;
    int k = 0;
    const TopTools_ListOfShape& mods = uh->Modified(f);
    for (TopTools_ListIteratorOfListOfShape it(mods); it.More() && !k; it.Next()) k = mfaces.FindIndex(it.Value());
    if (!k) k = mfaces.FindIndex(f);
    if (!k) throw OcctError(what + " failed: region " + out.selKeys[s] + " was lost while merging the profiles");
    out.faceOfSel[s] = k - 1;
    out.keysOf[k - 1].push_back(out.selKeys[s]);
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
  for (int i = 1; i <= mfaces.Extent(); ++i) {
    auto P = std::make_shared<Profile>();
    P->ax = R->ax;
    P->face = TopoDS::Face(mfaces(i));
    TopTools_IndexedMapOfShape fe;
    TopExp::MapShapes(P->face, TopAbs_EDGE, fe);
    for (int k = 1; k <= fe.Extent(); ++k) {
      const int t = tokEdges.FindIndex(fe(k));
      if (!t) throw OcctError(what + " failed: a profile edge lies on no sketch curve");
      P->segEdges.emplace_back(tokOf[t - 1], TopoDS::Edge(fe(k)));
    }
    out.profiles.push_back(P);
    out.faces.push_back(P->face);
  }
  return out;
}

// Several swept profiles as one shape (fused when there are several) and their merged
// history: `sides` per sub-segment token, `caps` per region key ({start, end}; merged
// regions share theirs), `start`/`end` = the first selected region's, `on_axis` (revolve).
struct SweptOut {
  int id = 0;
  JV hist;
};

SweptOut fuseSweeps(std::vector<Sweep>& sweeps, const RegionProfiles& RP, const std::string& what) {
  SweptOut so;
  std::vector<JV> hists;
  auto axisOf = [](Sweep& sw) { return sw.onAxis.empty() ? nullptr : &sw.onAxis; };
  if (sweeps.size() == 1) {
    Sweep& sw = sweeps[0];
    so.id = putShape(sw.shape);
    hists.push_back(sweepHistory(so.id, *sw.prof, sw.generated, sw.first, sw.last, axisOf(sw)));
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
    if (fu->HasErrors()) throw OcctError(what + " failed while joining the profiles: " + algoErrors(*fu));
    so.id = putShape(unwrap(fu->Shape()));
    for (auto& sw : sweeps) {
      auto gen = sw.generated;
      hists.push_back(sweepHistory(
          so.id, *sw.prof, [&](const TopoDS_Shape& e) { return throughBoolean(*fu, gen(e)); },
          firstThroughBoolean(*fu, sw.first), firstThroughBoolean(*fu, sw.last), axisOf(sw)));
    }
  }
  JV hfaces = JV::arr();
  JV sides = JV::obj();
  JV caps = JV::obj();
  JV axisSegs = JV::arr();
  bool anyAxis = false;
  for (size_t i = 0; i < hists.size(); ++i) {
    for (auto& f : hists[i].get("faces")->items()) hfaces.push(f);
    for (auto& kv : hists[i].get("sides")->members()) sides.set(kv.first, kv.second);
    if (const JV* oa = hists[i].get("on_axis")) {
      anyAxis = true;
      for (auto& s : oa->items()) axisSegs.push(s);
    }
    for (auto& key : RP.keysOf[i]) {
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
  hist.set("start", *hists[RP.faceOfSel[0]].get("start"));
  hist.set("end", *hists[RP.faceOfSel[0]].get("end"));
  hist.set("caps", std::move(caps));
  if (anyAxis) hist.set("on_axis", std::move(axisSegs));
  so.hist = std::move(hist);
  return so;
}

// A profile moved by a vector (copied geometry; edges mapped): the start of an extrude
// along a direction that is not the profile's normal (API 4).
std::unique_ptr<Profile> movedProfile(const Profile& base, const gp_Vec& v) {
  if (v.Magnitude() < 1e-300) return shiftedProfile(base, 0);
  std::unique_ptr<Profile> P(new Profile());
  P->ax = base.ax;
  gp_Trsf t;
  t.SetTranslation(v);
  BRepBuilderAPI_Transform tf(base.face, t, Standard_True);
  if (!tf.IsDone()) throw OcctError("extrude failed (moving the profile)");
  P->face = TopoDS::Face(tf.Shape());
  for (auto& se : base.segEdges) P->segEdges.emplace_back(se.first, TopoDS::Edge(tf.ModifiedShape(se.second)));
  P->ax.Translate(v);
  return P;
}

// The extrude direction (API 4): the profile's normal, or `direction` (an axis the user
// picked; not in the profile's plane, no taper), reversed with flip. `oblique`: not the normal.
struct ExtrudeDir {
  gp_Dir de;
  double sigma = 1;
  bool oblique = false;
};

ExtrudeDir extrudeDir(const JV& q, const gp_Dir& n, bool tapered) {
  ExtrudeDir r;
  const bool flip = q.boolean("flip", false);
  r.sigma = flip ? -1.0 : 1.0;
  gp_Dir d = n;
  if (const JV* jd = q.get("direction")) {
    if (!jd->isNull()) {
      d = dir(*jd);
      const double c = gp_Vec(d.XYZ()).Dot(gp_Vec(n.XYZ()));
      if (fabs(c) < 1e-6) throw InputError("the direction lies in the profile's plane: pick one that leaves it");
      r.oblique = fabs(c - 1) > 1e-12;
      if (tapered && r.oblique) throw InputError("taper is not available along a direction other than the normal");
    }
  }
  r.de = flip ? d.Reversed() : d;
  return r;
}

// Extrude sketch regions by key (regionProfiles): each merged face is swept as `extrude`
// does (same extents, flip, taper) and several are fused. History: `sides` per unsigned
// sub-segment token (faces entries `seg` = that token), `caps` per region key ({start,
// end}; merged regions share theirs), `start`/`end` = the first region's.
JV opExtrudeRegions(const JV& q) {
  const JV& ext = q.req("extent");
  const bool flip = q.boolean("flip", false);
  const double taper = q.num("taper_deg", 0);
  const bool tapered = fabs(taper) >= 1e-12;
  RegionProfiles RP = regionProfiles(q, "extrude");
  const SketchRegionSet& R = *RP.R;
  const gp_Dir n = R.ax.Direction();
  const ExtrudeDir ed = extrudeDir(q, n, tapered);
  const gp_Dir de = ed.de;
  const gp_Pnt o = R.ax.Location();
  const double sigma = ed.sigma;
  (void)flip;
  const ExtentPlan pl = planExtent(ext, o, de, tapered, RP.faces);
  if (tapered && fabs(taper * kDeg) >= 0.5 * M_PI - 1e-6) throw InputError("taper must be between -90 and 90 degrees");
  std::vector<Sweep> sweeps;
  for (auto& P : RP.profiles) {
    const Profile& base = *P;
    // The start moves along the direction (s0 = shift * sigma).
    auto at = [&](double shift) { return ed.oblique ? movedProfile(base, gp_Vec(de.XYZ()) * (shift * sigma)) : shiftedProfile(base, shift); };
    sweeps.push_back(sweepProfile(at, pl, o, n, de, sigma, taper));
  }
  SweptOut so = fuseSweeps(sweeps, RP, "extrude");
  JV r = JV::obj();
  r.set("id", so.id);
  r.set("history", std::move(so.hist));
  addValidity(r, so.id, q);
  r.set("from", pl.s0);
  r.set("to", pl.s0 + pl.L);
  r.set("direction", d3(de));
  r.set("solids", countOf(shapeOf(so.id), TopAbs_SOLID));
  return r;
}

// ------------------------------------------------------------------ API 4 ---
// P4a solids: revolve, sweep and loft of sketch regions, extrude of a body's flat face,
// fillet diagnosis, and the edge queries reference geometry needs (edge_eval, topo
// edge_ends / vertex_faces).

// A profile turned about an axis by `rad` (copied geometry; edges mapped).
std::unique_ptr<Profile> rotatedProfile(const Profile& base, const gp_Ax1& axis, double rad) {
  std::unique_ptr<Profile> P(new Profile());
  P->ax = base.ax;
  if (fabs(rad) < 1e-300) {
    P->face = base.face;
    P->segEdges = base.segEdges;
    return P;
  }
  gp_Trsf t;
  t.SetRotation(axis, rad);
  BRepBuilderAPI_Transform tf(base.face, t, Standard_True);
  if (!tf.IsDone()) throw OcctError("revolve failed (turning the profile)");
  P->face = TopoDS::Face(tf.Shape());
  for (auto& se : base.segEdges) P->segEdges.emplace_back(se.first, TopoDS::Edge(tf.ModifiedShape(se.second)));
  P->ax.Transform(t);
  return P;
}

// Points along an edge (k = 0..n), for the side tests below.
std::vector<gp_Pnt> edgeSamples(const TopoDS_Edge& e, int n) {
  std::vector<gp_Pnt> out;
  if (BRep_Tool::Degenerated(e)) return out;
  BRepAdaptor_Curve c(e);
  const double f = c.FirstParameter(), l = c.LastParameter();
  for (int k = 0; k <= n; ++k) out.push_back(c.Value(f + (l - f) * k / n));
  return out;
}

// Revolve sketch regions about an axis (API 4). axis {origin, dir} in model mm (any line:
// a sketch line, a model edge, an axis feature, an origin axis). extent:
//   {kind:"one", angle}            degrees from the sketch, turning about +dir (right hand)
//   {kind:"symmetric", angle}      the whole angle, half on each side of the sketch
//   {kind:"two", angle, angle2}    angle about +dir, angle2 the other way
// flip turns the other way. 360 in all is a full revolve (no caps). The axis must not be
// perpendicular to the sketch plane, and a profile must not cross an axis that lies in
// its plane (both refused with the reason). History as extrude_regions, plus `on_axis`
// (sub-segments on the axis sweep no face). The result says the angles used.
JV opRevolveRegions(const JV& q) {
  RegionProfiles RP = regionProfiles(q, "revolve");
  const SketchRegionSet& R = *RP.R;
  const JV& jax = q.req("axis");
  const gp_Pnt ao = pnt(jax.req("origin"));
  gp_Dir ad = dir(jax.req("dir"));
  if (q.boolean("flip", false)) ad.Reverse();
  const gp_Ax1 axis(ao, ad);
  const JV& ext = q.req("extent");
  const std::string kind = ext.str("kind", "one");
  double a1 = 0, a2 = 0;
  if (kind == "one") {
    a1 = ext.num("angle");
  } else if (kind == "symmetric") {
    a1 = a2 = ext.num("angle") / 2;
  } else if (kind == "two") {
    a1 = ext.num("angle");
    a2 = ext.num("angle2");
  } else {
    throw InputError("unknown revolve extent '" + kind + "'");
  }
  const double total = a1 + a2;
  if (!(total > 1e-9)) throw InputError("the revolve angle must be more than 0");
  if (total > 360 + 1e-9) throw InputError("the angles add up to more than 360 degrees");
  const bool full = total >= 360 - 1e-9;
  const gp_Dir n = R.ax.Direction();
  const double along = gp_Vec(ad.XYZ()).Dot(gp_Vec(n.XYZ()));
  if (fabs(along) > 1 - 1e-9) throw InputError("the axis is perpendicular to the sketch plane: pick an axis that lies in the plane or beside it");
  const double scale = std::max(1.0, R.extent);
  const double tol = 1e-7 * scale;
  const bool inPlane = fabs(along) < 1e-9 && fabs(gp_Vec(R.ax.Location(), ao).Dot(gp_Vec(n.XYZ()))) < 1e-6 * scale;
  if (inPlane) {
    for (auto& P : RP.profiles) {
      bool pos = false, neg = false;
      for (TopExp_Explorer ex(P->face, TopAbs_EDGE); ex.More(); ex.Next())
        for (const gp_Pnt& p : edgeSamples(TopoDS::Edge(ex.Current()), 8)) {
          const double s = gp_Vec(ao, p).Crossed(gp_Vec(ad.XYZ())).Dot(gp_Vec(n.XYZ()));
          if (s > 10 * tol) pos = true;
          else if (s < -10 * tol) neg = true;
        }
      if (pos && neg) throw InputError("the profile crosses the axis: keep the profile on one side of the axis");
    }
  }
  const gp_Lin axisLine(ao, ad);
  std::vector<Sweep> sweeps;
  for (auto& P0 : RP.profiles) {
    std::shared_ptr<Profile> P(rotatedProfile(*P0, axis, full ? 0.0 : -a2 * kDeg).release());
    auto mr = std::make_shared<BRepPrimAPI_MakeRevol>(P->face, axis, full ? 2 * M_PI : total * kDeg, Standard_False);
    mr->Build();
    if (!mr->IsDone()) throw OcctError("revolve failed");
    Sweep sw;
    sw.keep.push_back(mr);
    sw.prof = P;
    sw.shape = mr->Shape();
    sw.generated = [mr](const TopoDS_Shape& e) { return mr->Generated(e); };
    if (!full) {
      sw.first = mr->FirstShape();
      sw.last = mr->LastShape();
    }
    sw.onAxis.assign(P->segEdges.size(), false);
    for (size_t k = 0; k < P->segEdges.size(); ++k) {
      bool on = true;
      for (const gp_Pnt& p : edgeSamples(P->segEdges[k].second, 4))
        if (axisLine.Distance(p) > 10 * tol) on = false;
      sw.onAxis[k] = on;
    }
    sweeps.push_back(std::move(sw));
  }
  SweptOut so = fuseSweeps(sweeps, RP, "revolve");
  JV r = JV::obj();
  r.set("id", so.id);
  r.set("history", std::move(so.hist));
  addValidity(r, so.id, q);
  r.set("full", full);
  r.set("from_deg", full ? 0.0 : -a2);
  r.set("to_deg", full ? 360.0 : a1);
  r.set("solids", countOf(shapeOf(so.id), TopAbs_SOLID));
  return r;
}

// A sweep path: curves of a sketch (lines, arcs, one circle), chained end to end into one
// wire. `entities` (optional) picks which curves of the list make the path. Each edge of
// the wire is tagged with its curve id, in path order.
struct PathWire {
  TopoDS_Wire wire;
  std::vector<std::pair<std::string, TopoDS_Edge>> edges;
  bool closed = false;
};

PathWire buildPath(const JV& jp) {
  const gp_Ax3 ax = sketchFrame(jp.req("plane"));
  auto to3 = [&](const gp_Pnt2d& q) {
    return gp_Pnt(ax.Location().XYZ() + ax.XDirection().XYZ() * q.X() + ax.YDirection().XYZ() * q.Y());
  };
  std::set<std::string> want;
  if (const JV* je = jp.get("entities"))
    if (je->isArr())
      for (auto& x : je->items()) want.insert(x.str());
  struct PC {
    std::string id;
    TopoDS_Edge e;
    gp_Pnt a, b;
    bool circle = false;
  };
  std::vector<PC> cs;
  double scale = 1;
  for (auto& c : jp.req("curves").items()) {
    const std::string kind = c.str("kind");
    const std::string id = c.str("id");
    if (kind == "point") continue;
    if (!want.empty() && !want.count(id)) continue;
    PC pc;
    pc.id = id;
    if (kind == "line") {
      const gp_Pnt2d a = uv(c.req("a")), b = uv(c.req("b"));
      BRepBuilderAPI_MakeEdge me(to3(a), to3(b));
      if (!me.IsDone()) throw InputError("path line " + id + " cannot be built");
      pc.e = me.Edge();
      scale = std::max({scale, fabs(a.X()), fabs(a.Y()), fabs(b.X()), fabs(b.Y())});
    } else if (kind == "arc" || kind == "circle") {
      const gp_Pnt2d cc = uv(c.req("c"));
      const double r = c.num("r");
      if (!(r > 0)) throw InputError("path " + kind + " " + id + " needs a radius > 0");
      gp_Circ circ(gp_Ax2(to3(cc), ax.Direction(), ax.XDirection()), r);
      if (kind == "circle") {
        pc.e = BRepBuilderAPI_MakeEdge(circ).Edge();
        pc.circle = true;
      } else {
        const double a0 = c.num("a0") * kDeg, a1 = c.num("a1") * kDeg;
        const bool ccw = c.boolean("ccw", true);
        const double sweep = wrap2Pi((ccw ? 1.0 : -1.0) * (a1 - a0));
        if (sweep < 1e-12) throw InputError("path arc " + id + " has no length");
        BRepBuilderAPI_MakeEdge me = ccw ? BRepBuilderAPI_MakeEdge(circ, a0, a0 + sweep) : BRepBuilderAPI_MakeEdge(circ, a1, a1 + sweep);
        if (!me.IsDone()) throw InputError("path arc " + id + " cannot be built");
        pc.e = me.Edge();
      }
      scale = std::max({scale, fabs(cc.X()) + r, fabs(cc.Y()) + r});
    } else if (kind == "bspline") {
      Handle(Geom2d_BSplineCurve) b2 = bspline2d(c, id);
      BRepBuilderAPI_MakeEdge me(bsplineOnPlane(b2, ax));
      if (!me.IsDone()) throw InputError("bspline " + id + ": the path curve cannot be built");
      pc.e = me.Edge();
      for (int i = 1; i <= b2->NbPoles(); ++i) scale = std::max({scale, fabs(b2->Pole(i).X()), fabs(b2->Pole(i).Y())});
      pc.circle = b2->StartPoint().Distance(b2->EndPoint()) <= 1e-9 * scale;  // a closed spline is a path on its own
    } else {
      throw InputError("unknown path curve kind '" + kind + "' (" + id + ")");
    }
    BRepAdaptor_Curve ac(pc.e);
    pc.a = ac.Value(ac.FirstParameter());
    pc.b = ac.Value(ac.LastParameter());
    cs.push_back(pc);
  }
  if (cs.empty()) throw InputError("the path has no curves (construction lines are not a path)");
  std::sort(cs.begin(), cs.end(), [](const PC& x, const PC& y) { return x.id < y.id; });
  const double tol = 1e-6 * scale;
  PathWire out;
  for (auto& c : cs)
    if (c.circle && cs.size() > 1) throw InputError("a circle or a closed spline is a path on its own: the path's other curves cannot join it");
  // Chain: start at an end that no other curve meets (an open path), else anywhere (closed).
  auto meets = [&](const gp_Pnt& p, size_t self) {
    int n = 0;
    for (size_t j = 0; j < cs.size(); ++j) {
      if (j == self) continue;
      if (cs[j].a.Distance(p) <= tol) ++n;
      if (cs[j].b.Distance(p) <= tol) ++n;
    }
    return n;
  };
  for (size_t i = 0; i < cs.size(); ++i)
    for (const gp_Pnt& p : {cs[i].a, cs[i].b})
      if (meets(p, i) > 1) throw InputError("the path branches: a path is one chain of curves, end to end");
  size_t start = 0;
  bool startAtB = false;
  bool open = false;
  for (size_t i = 0; i < cs.size() && !open; ++i) {
    if (cs[i].circle) continue;
    if (meets(cs[i].a, i) == 0) {
      start = i;
      startAtB = false;
      open = true;
    } else if (meets(cs[i].b, i) == 0) {
      start = i;
      startAtB = true;
      open = true;
    }
  }
  std::vector<bool> used(cs.size(), false);
  std::vector<std::pair<size_t, bool>> order;  // curve, reversed
  order.push_back({start, startAtB});
  used[start] = true;
  gp_Pnt cur = startAtB ? cs[start].a : cs[start].b;
  for (size_t k = 1; k < cs.size(); ++k) {
    bool found = false;
    for (size_t j = 0; j < cs.size() && !found; ++j) {
      if (used[j]) continue;
      if (cs[j].a.Distance(cur) <= tol) {
        order.push_back({j, false});
        cur = cs[j].b;
        used[j] = found = true;
      } else if (cs[j].b.Distance(cur) <= tol) {
        order.push_back({j, true});
        cur = cs[j].a;
        used[j] = found = true;
      }
    }
    if (!found) throw InputError("the path has a gap: its curves must join end to end in one chain");
  }
  const gp_Pnt begin = order[0].second ? cs[order[0].first].b : cs[order[0].first].a;
  out.closed = cs.size() == 1 ? (cs[0].circle || cs[0].a.Distance(cs[0].b) <= tol) : (!open && cur.Distance(begin) <= tol);
  BRepBuilderAPI_MakeWire mw;
  for (auto& o : order) {
    TopoDS_Edge e = cs[o.first].e;
    if (o.second) e.Reverse();
    mw.Add(e);
    if (!mw.IsDone()) throw InputError("path curve " + cs[o.first].id + " does not join the path");
    out.edges.emplace_back(cs[o.first].id, mw.Edge());
  }
  out.wire = mw.Wire();
  return out;
}

// Sweep sketch regions along a path (API 4): each merged region face along the path wire
// (buildPath). orientation "follow" (default: the profile turns with the path, corrected
// Frenet; BRepOffsetAPI_MakePipe of the face) or "fixed" (the profile keeps its orientation
// and is only moved along the path: BRepOffsetAPI_MakePipeShell with a fixed trihedron, one
// pipe per wire of the face, the holes' pipes cut from the outer one; MakePipe ignores
// GeomFill_IsFixed, P4a review). History: each side face by the profile sub-segment and the
// path curve that made it, `sides` keyed "<token>@<path curve id>", caps `start` / `end`
// (none on a closed path), `caps` per region key. Several regions are fused.
JV opSweepRegions(const JV& q) {
  RegionProfiles RP = regionProfiles(q, "sweep");
  const PathWire path = buildPath(q.req("path"));
  const std::string orient = q.str("orientation", "follow");
  if (orient != "follow" && orient != "fixed") throw InputError("orientation must be follow or fixed");
  const bool fixed = orient == "fixed";
  // Where the path starts (the fixed sweep moves the profile by path(t) - path(start)).
  gp_Pnt pathStart;
  {
    const TopoDS_Edge& e0 = path.edges.front().second;
    BRepAdaptor_Curve c(e0);
    pathStart = c.Value(e0.Orientation() == TopAbs_REVERSED ? c.LastParameter() : c.FirstParameter());
  }
  struct One {
    TopoDS_Shape shape;
    std::shared_ptr<BRepOffsetAPI_MakePipe> mp;                        // follow
    std::vector<std::shared_ptr<BRepOffsetAPI_MakePipeShell>> ps;      // fixed: outer wire, then holes
    std::vector<TopTools_IndexedMapOfShape> wireEdges;                 // fixed: the edges of each wire
    std::shared_ptr<BRepAlgoAPI_Cut> cut;                              // fixed with holes
    std::shared_ptr<Profile> P;
    TopoDS_Shape first, last;
    // The face of `shape` made by profile edge `se` along path edge `pe` (null when none).
    TopoDS_Shape generated(const TopoDS_Edge& pe, const TopoDS_Edge& se, const gp_Pnt& start) const {
      if (mp) return mp->Generated(pe, se);
      for (size_t k = 0; k < ps.size(); ++k) {
        if (!wireEdges[k].Contains(se)) continue;
        // The face lies where the middle of the profile edge goes at the middle of the path edge.
        BRepAdaptor_Curve cs(se), cp(pe);
        const gp_Pnt m = cs.Value(0.5 * (cs.FirstParameter() + cs.LastParameter()));
        const gp_Pnt pm = cp.Value(0.5 * (cp.FirstParameter() + cp.LastParameter()));
        const gp_Pnt at = m.Translated(gp_Vec(start, pm));
        const TopoDS_Vertex v = BRepBuilderAPI_MakeVertex(at).Vertex();
        TopTools_ListOfShape gen;
        gen = ps[k]->Generated(se);
        TopoDS_Shape best;
        double bestD = 1e-3;
        for (TopTools_ListIteratorOfListOfShape it(gen); it.More(); it.Next()) {
          if (it.Value().ShapeType() != TopAbs_FACE) continue;
          BRepExtrema_DistShapeShape d(v, it.Value());
          if (!d.IsDone()) continue;
          const double tol = std::max(bestD, 10 * BRep_Tool::Tolerance(TopoDS::Face(it.Value())));
          if (d.Value() <= tol && (best.IsNull() || d.Value() < bestD)) {
            best = it.Value();
            bestD = std::max(d.Value(), 1e-9);
          }
        }
        if (best.IsNull()) return best;
        return cut ? firstThroughBoolean(*cut, best) : best;
      }
      return TopoDS_Shape();
    }
  };
  std::vector<One> pipes;
  for (auto& P : RP.profiles) {
    One one;
    one.P = P;
    if (!fixed) {
      auto mp = std::make_shared<BRepOffsetAPI_MakePipe>(path.wire, P->face, GeomFill_IsCorrectedFrenet, Standard_False);
      mp->Build();
      if (!mp->IsDone() || mp->Shape().IsNull()) throw OcctError("sweep failed: the profile cannot follow this path");
      one.mp = mp;
      one.shape = mp->Shape();
      one.first = mp->FirstShape();
      one.last = mp->LastShape();
    } else {
      const gp_Ax2 keep(P->ax.Location(), P->ax.Direction(), P->ax.XDirection());
      std::vector<TopoDS_Wire> wires;
      const TopoDS_Wire outer = BRepTools::OuterWire(P->face);
      wires.push_back(outer);
      for (TopExp_Explorer ex(P->face, TopAbs_WIRE); ex.More(); ex.Next())
        if (!ex.Current().IsSame(outer)) wires.push_back(TopoDS::Wire(ex.Current()));
      std::vector<TopoDS_Shape> solids;
      for (auto& w : wires) {
        auto ps = std::make_shared<BRepOffsetAPI_MakePipeShell>(path.wire);
        ps->SetMode(keep);
        ps->Add(w, Standard_False, Standard_False);
        ps->Build();
        if (!ps->IsDone()) throw OcctError("sweep failed: the profile cannot be moved along this path");
        if (!ps->MakeSolid()) throw OcctError("sweep failed: the swept profile does not close into a solid");
        TopTools_IndexedMapOfShape em;
        TopExp::MapShapes(w, TopAbs_EDGE, em);
        one.ps.push_back(ps);
        one.wireEdges.push_back(em);
        solids.push_back(ps->Shape());
      }
      one.first = one.ps[0]->FirstShape();
      one.last = one.ps[0]->LastShape();
      if (solids.size() == 1) {
        one.shape = solids[0];
      } else {
        TopTools_ListOfShape A, T;
        A.Append(solids[0]);
        for (size_t k = 1; k < solids.size(); ++k) T.Append(solids[k]);
        one.cut = std::make_shared<BRepAlgoAPI_Cut>();
        one.cut->SetArguments(A);
        one.cut->SetTools(T);
        one.cut->SetRunParallel(false);
        one.cut->SetToFillHistory(true);
        one.cut->Build();
        if (one.cut->HasErrors()) throw OcctError("sweep failed while cutting the profile's holes: " + algoErrors(*one.cut));
        one.shape = unwrap(one.cut->Shape());
        one.first = firstThroughBoolean(*one.cut, one.first);
        one.last = firstThroughBoolean(*one.cut, one.last);
      }
    }
    if (one.shape.IsNull()) throw OcctError("sweep failed: the profile cannot follow this path");
    pipes.push_back(std::move(one));
  }
  std::shared_ptr<BRepAlgoAPI_Fuse> fu;
  TopoDS_Shape res;
  if (pipes.size() == 1) {
    res = pipes[0].shape;
  } else {
    TopTools_ListOfShape A, T;
    A.Append(pipes[0].shape);
    for (size_t i = 1; i < pipes.size(); ++i) T.Append(pipes[i].shape);
    fu = std::make_shared<BRepAlgoAPI_Fuse>();
    fu->SetArguments(A);
    fu->SetTools(T);
    fu->SetRunParallel(false);
    fu->SetToFillHistory(true);
    fu->Build();
    if (fu->HasErrors()) throw OcctError("sweep failed while joining the profiles: " + algoErrors(*fu));
    res = unwrap(fu->Shape());
  }
  const int id = putShape(res);
  Indexed& out = indexOf(id);
  auto through = [&](const TopoDS_Shape& s) -> int {
    if (s.IsNull()) return -1;
    return faceIndexIn(id, fu ? firstThroughBoolean(*fu, s) : s);
  };
  JV faces = JV::arr();
  JV sides = JV::obj();
  JV caps = JV::obj();
  std::vector<bool> named(out.f.Extent(), false);
  auto addFace = [&](int fi, JV src) {
    if (fi < 0 || named[fi]) return;
    named[fi] = true;
    JV f = JV::obj();
    f.set("out", fi);
    JV from = JV::arr();
    from.push(std::move(src));
    f.set("from", std::move(from));
    faces.push(std::move(f));
  };
  std::vector<std::pair<int, int>> capsOf(pipes.size(), {-1, -1});
  for (size_t i = 0; i < pipes.size(); ++i) {
    auto& one = pipes[i];
    for (auto& pe : path.edges)
      for (auto& se : one.P->segEdges) {
        TopoDS_Shape g;
        try {
          g = one.generated(pe.second, se.second, pathStart);
        } catch (const Standard_Failure&) {
          continue;
        }
        const int fi = through(g);
        if (fi < 0) continue;
        const std::string key = se.first + "@" + pe.first;
        if (!named[fi]) sides.set(key, fi);
        JV src = JV::obj();
        src.set("seg", key);
        src.set("how", "generated");
        addFace(fi, std::move(src));
      }
    if (!path.closed) {
      const int s = through(one.first), e = through(one.last);
      capsOf[i] = {s, e};
      for (auto cap : {std::make_pair("start", s), std::make_pair("end", e)}) {
        JV src = JV::obj();
        src.set("cap", cap.first);
        src.set("how", "generated");
        addFace(cap.second, std::move(src));
      }
    }
    for (auto& key : RP.keysOf[i]) {
      JV c = JV::obj();
      c.set("start", capsOf[i].first >= 0 ? JV(capsOf[i].first) : JV());
      c.set("end", capsOf[i].second >= 0 ? JV(capsOf[i].second) : JV());
      caps.set(key, std::move(c));
    }
  }
  const auto& first = capsOf[RP.faceOfSel[0]];
  JV hist = JV::obj();
  hist.set("faces", std::move(faces));
  hist.set("edges", JV::arr());
  hist.set("deleted", JV::arr());
  hist.set("sides", std::move(sides));
  hist.set("start", first.first >= 0 ? JV(first.first) : JV());
  hist.set("end", first.second >= 0 ? JV(first.second) : JV());
  hist.set("caps", std::move(caps));
  JV r = JV::obj();
  r.set("id", id);
  r.set("history", std::move(hist));
  addValidity(r, id, q);
  r.set("closed_path", path.closed);
  r.set("solids", countOf(res, TopAbs_SOLID));
  return r;
}

// Loft through two or more sections (API 4): each section is {plane, curves, regions}
// of one sketch whose regions make one face without holes (refused otherwise, with the
// reason); BRepOffsetAPI_ThruSections through their outer wires, in order, as a solid
// (ruled: straight between sections). History: side faces by the first section's
// sub-segment token that made them (`seg` = token; faces made only by a later section's
// edge: "<token>@<section index>"), caps `start` (first section) and `end` (last).
JV opLoftRegions(const JV& q) {
  const JV& secs = q.req("sections");
  if (!secs.isArr() || secs.size() < 2) throw InputError("a loft needs at least two profiles");
  const bool ruled = q.boolean("ruled", false);
  auto ts = std::make_shared<BRepOffsetAPI_ThruSections>(Standard_True, ruled ? Standard_True : Standard_False, 1e-6);
  ts->CheckCompatibility(Standard_True);
  std::vector<std::vector<std::pair<std::string, TopoDS_Edge>>> secEdges;
  std::vector<RegionProfiles> keepRP;
  int i = 0;
  for (auto& s : secs.items()) {
    ++i;
    RegionProfiles RP = regionProfiles(s, "loft");
    if (RP.profiles.size() != 1) throw InputError("profile " + std::to_string(i) + " of the loft is several separate regions: pick regions that make one shape");
    const TopoDS_Face& F = RP.profiles[0]->face;
    int nw = 0;
    for (TopExp_Explorer ex(F, TopAbs_WIRE); ex.More(); ex.Next()) ++nw;
    if (nw > 1) throw InputError("profile " + std::to_string(i) + " of the loft has a hole: a loft takes profiles without holes");
    TopoDS_Wire w = BRepTools::OuterWire(F);
    ts->AddWire(w);
    std::vector<std::pair<std::string, TopoDS_Edge>> es;
    for (TopExp_Explorer ex(w, TopAbs_EDGE); ex.More(); ex.Next())
      for (auto& se : RP.profiles[0]->segEdges)
        if (se.second.IsSame(ex.Current())) {
          es.emplace_back(se.first, TopoDS::Edge(ex.Current()));
          break;
        }
    secEdges.push_back(es);
    keepRP.push_back(std::move(RP));
  }
  ts->Build();
  if (!ts->IsDone() || ts->Shape().IsNull()) throw OcctError("loft failed: the profiles cannot be joined into one solid");
  const int id = putShape(unwrap(ts->Shape()));
  Indexed& out = indexOf(id);
  std::vector<bool> named(out.f.Extent(), false);
  JV faces = JV::arr();
  JV sides = JV::obj();
  auto addFace = [&](int fi, JV src) {
    if (fi < 0 || named[fi]) return;
    named[fi] = true;
    JV f = JV::obj();
    f.set("out", fi);
    JV from = JV::arr();
    from.push(std::move(src));
    f.set("from", std::move(from));
    faces.push(std::move(f));
  };
  for (size_t k = 0; k < secEdges.size(); ++k)
    for (auto& se : secEdges[k]) {
      TopTools_ListOfShape gens;
      try {
        gens = ts->Generated(se.second);
      } catch (const Standard_Failure&) {
        continue;
      }
      for (TopTools_ListIteratorOfListOfShape it(gens); it.More(); it.Next()) {
        if (it.Value().ShapeType() != TopAbs_FACE) continue;
        const int fi = faceIndexIn(id, it.Value());
        if (fi < 0 || named[fi]) continue;
        const std::string key = k == 0 ? se.first : se.first + "@" + std::to_string(k);
        sides.set(key, fi);
        JV src = JV::obj();
        src.set("seg", key);
        src.set("how", "generated");
        addFace(fi, std::move(src));
      }
    }
  const int s = faceIndexIn(id, ts->FirstShape()), e = faceIndexIn(id, ts->LastShape());
  for (auto cap : {std::make_pair("start", s), std::make_pair("end", e)}) {
    JV src = JV::obj();
    src.set("cap", cap.first);
    src.set("how", "generated");
    addFace(cap.second, std::move(src));
  }
  JV hist = JV::obj();
  hist.set("faces", std::move(faces));
  hist.set("edges", JV::arr());
  hist.set("deleted", JV::arr());
  hist.set("sides", std::move(sides));
  hist.set("start", s >= 0 ? JV(s) : JV());
  hist.set("end", e >= 0 ? JV(e) : JV());
  JV r = JV::obj();
  r.set("id", id);
  r.set("history", std::move(hist));
  addValidity(r, id, q);
  r.set("solids", countOf(shapeOf(id), TopAbs_SOLID));
  return r;
}

// Extrude a flat face of a body (API 4, Daniel's item 8: no sketch): the face (a copy;
// the body is not changed) is the profile, its outward normal the direction (flip:
// into the body). Extents as extrude (no taper). History: the side swept from input edge
// i has `seg` "e<i>" (the caller names it by that edge), caps `start` (on the face) and
// `end`. The result says the span used: `from`, `to` along `direction`.
JV opExtrudeFace(const JV& q) {
  const int sid = idParam(q.req("id"), "id");
  const int fi = (int)q.req("face").num();
  const TopoDS_Face F = faceAt(sid, q.req("face"));
  gp_Pln fpl;
  gp_Dir nOut;
  if (!planarFace(F, fpl, nOut)) throw InputError("extrude needs a flat face: face " + std::to_string(fi) + " is " + surfWords(F));
  if (fabs(q.num("taper_deg", 0)) >= 1e-12) throw InputError("taper is not available when extruding a face");
  const JV& ext = q.req("extent");
  const bool flip = q.boolean("flip", false);
  Indexed& in = indexOf(sid);
  BRepBuilderAPI_Copy cp(F, Standard_True, Standard_False);
  auto base = std::make_shared<Profile>();
  gp_Vec xv(fpl.Position().XDirection().XYZ());
  xv -= gp_Vec(nOut.XYZ()) * xv.Dot(gp_Vec(nOut.XYZ()));
  base->ax = gp_Ax3(fpl.Location(), nOut, gp_Dir(xv));
  base->face = TopoDS::Face(cp.Shape());
  TopTools_IndexedMapOfShape fe;
  TopExp::MapShapes(F, TopAbs_EDGE, fe);
  for (int k = 1; k <= fe.Extent(); ++k) {
    const int ei = in.e.FindIndex(fe(k));
    if (!ei) continue;
    base->segEdges.emplace_back("e" + std::to_string(ei - 1), TopoDS::Edge(cp.ModifiedShape(fe(k))));
  }
  const gp_Dir n = nOut;
  const ExtrudeDir ed = extrudeDir(q, n, false);
  const gp_Dir de = ed.de;
  const gp_Pnt o = base->ax.Location();
  const double sigma = ed.sigma;
  (void)flip;
  const ExtentPlan pl = planExtent(ext, o, de, false, {base->face});
  auto at = [&](double shift) { return ed.oblique ? movedProfile(*base, gp_Vec(de.XYZ()) * (shift * sigma)) : shiftedProfile(*base, shift); };
  Sweep sw = sweepProfile(at, pl, o, n, de, sigma, 0.0);
  const int id = putShape(sw.shape);
  JV r = JV::obj();
  r.set("id", id);
  r.set("history", sweepHistory(id, *sw.prof, sw.generated, sw.first, sw.last));
  addValidity(r, id, q);
  r.set("from", pl.s0);
  r.set("to", pl.s0 + pl.L);
  r.set("direction", d3(de));
  return r;
}

// Why a fillet fails, and what would work (API 4; the Fillet feature's failure words).
// Runs the fillet with radius r on a fresh work copy. When it fails or its result is not
// a valid solid: `faulty` (input edge indices of the contours OCCT could not fillet),
// `failed` (OCCT refused outright, not merely an invalid result) and `max_ok`, the
// largest radius found to work (smaller radii tried in turn, then bisected: at most 10
// fillets), or null. Nothing is stored.
JV filletDiagnose(int sid, const JV& edges, double r) {
  auto attempt = [&](double rad, std::vector<int>* faulty, bool* outright) -> bool {
    WorkCopies wc({sid});
    const int wid = wc.id(0);
    BRepFilletAPI_MakeFillet mf(wc.shape(0));
    for (auto& e : edges.items()) mf.Add(rad, edgeAt(wid, e));
    try {
      mf.Build();
    } catch (const Standard_Failure&) {
      if (outright) *outright = true;
      return false;
    }
    if (!mf.IsDone()) {
      if (outright) *outright = true;
      if (faulty) {
        Indexed& w = indexOf(wid);
        for (int i = 1; i <= mf.NbFaultyContours(); ++i) {
          const int ic = mf.FaultyContour(i);
          if (ic < 1 || ic > mf.NbContours()) continue;
          for (int j = 1; j <= mf.NbEdges(ic); ++j) {
            const int k = w.e.FindIndex(mf.Edge(ic, j));
            if (k) faulty->push_back(k - 1);
          }
        }
      }
      return false;
    }
    TopoDS_Shape res = mf.Shape();
    if (res.IsNull()) return false;
    return analyse(unwrap(res)).valid;
  };
  std::vector<int> faulty;
  bool outright = false;
  const bool ok = attempt(r, &faulty, &outright);
  std::sort(faulty.begin(), faulty.end());
  faulty.erase(std::unique(faulty.begin(), faulty.end()), faulty.end());
  JV out = JV::obj();
  out.set("done", ok);
  out.set("failed", outright);
  JV fj = JV::arr();
  for (int k : faulty) fj.push(k);
  out.set("faulty", std::move(fj));
  if (ok) {
    out.set("max_ok", r);
    return out;
  }
  double good = -1, bad = r;
  for (double f : {0.75, 0.5, 0.25, 0.1, 0.02}) {
    if (attempt(r * f, nullptr, nullptr)) {
      good = r * f;
      break;
    }
    bad = r * f;
  }
  if (good > 0)
    for (int k = 0; k < 4; ++k) {
      const double mid = 0.5 * (good + bad);
      if (attempt(mid, nullptr, nullptr)) good = mid;
      else bad = mid;
    }
  out.set("max_ok", good > 0 ? JV(good) : JV());
  return out;
}

// One curve point and its unit tangent (direction of increasing parameter).
JV pointTangent(const BRepAdaptor_Curve& c, double u) {
  gp_Pnt p;
  gp_Vec v;
  c.D1(u, p, v);
  if (v.Magnitude() < 1e-12) {
    const double f = c.FirstParameter(), l = c.LastParameter(), h = 1e-6 * (l - f);
    const double u0 = std::max(f, u - h), u1 = std::min(l, u + h);
    v = gp_Vec(c.Value(u0), c.Value(u1));
  }
  JV o = JV::obj();
  o.set("p", p3(p));
  if (v.Magnitude() > 1e-300) o.set("tangent", d3(gp_Dir(v)));
  else o.set("tangent", vec3(0, 0, 0));
  return o;
}

// Points of an edge (API 4, REFERENCE's request R2): by arc length from `first` or by
// fraction of the length (`at`), every crossing with a plane (`plane`, ordered along the
// edge; none for an edge lying in it), and the nearest point to a point (`near`). The
// edge's own orientation is ignored: `first` is the curve's first parameter.
JV opEdgeEval(const JV& q) {
  const int sid = idParam(q.req("id"), "id");
  const TopoDS_Edge E = edgeAt(sid, q.req("edge"));
  JV r = JV::obj();
  if (BRep_Tool::Degenerated(E)) {
    TopoDS_Vertex v1, v2;
    TopExp::Vertices(E, v1, v2);
    const gp_Pnt p = v1.IsNull() ? gp_Pnt() : BRep_Tool::Pnt(v1);
    r.set("type", "degenerate");
    r.set("length", 0.0);
    r.set("first", p3(p));
    r.set("last", p3(p));
    r.set("closed", true);
    r.set("points", JV::arr());
    r.set("crossings", JV::arr());
    return r;
  }
  BRepAdaptor_Curve c(E);
  const double f = c.FirstParameter(), l = c.LastParameter();
  const double len = GCPnts_AbscissaPoint::Length(c);
  const gp_Pnt pf = c.Value(f), pl = c.Value(l);
  const double tol = std::max(1e-7, 1e-9 * len);
  r.set("type", curveType(c.GetType()));
  r.set("length", len);
  r.set("first", p3(pf));
  r.set("last", p3(pl));
  r.set("closed", BRep_Tool::IsClosed(E) || pf.Distance(pl) <= tol);
  JV pts = JV::arr();
  if (const JV* at = q.get("at")) {
    for (auto& a : at->items()) {
      double d;
      if (a.has("distance")) d = a.num("distance");
      else if (a.has("fraction")) d = a.num("fraction") * len;
      else throw InputError("each `at` needs a distance or a fraction");
      if (d < -tol || d > len + tol) {
        std::ostringstream os;
        os << "the point is past the end of the edge (length " << len << " mm)";
        throw InputError(os.str());
      }
      d = std::min(std::max(d, 0.0), len);
      double u;
      if (d <= 0) u = f;
      else if (d >= len) u = l;
      else {
        GCPnts_AbscissaPoint ap(c, d, f);
        if (!ap.IsDone()) throw OcctError("could not find the point at that distance along the edge");
        u = ap.Parameter();
      }
      pts.push(pointTangent(c, u));
    }
  }
  r.set("points", std::move(pts));
  JV cross = JV::arr();
  if (const JV* jp = q.get("plane")) {
    const gp_Pnt po = pnt(jp->req("origin"));
    const gp_Dir pn = dir(jp->req("normal"));
    auto sd = [&](double u) { return gp_Vec(po, c.Value(u)).Dot(gp_Vec(pn.XYZ())); };
    const int N = 256;
    std::vector<double> roots;
    double u0 = f, s0 = sd(f);
    bool allIn = fabs(s0) <= tol;
    for (int k = 1; k <= N; ++k) {
      const double u1 = f + (l - f) * k / N;
      const double s1 = sd(u1);
      if (fabs(s1) > tol) allIn = false;
      if (fabs(s0) <= tol) {
        if (roots.empty() || fabs(roots.back() - u0) > 1e-9 * (l - f)) roots.push_back(u0);
      } else if (s0 * s1 < 0) {
        double a = u0, b = u1, sa = s0;
        for (int it = 0; it < 80; ++it) {
          const double m = 0.5 * (a + b), sm = sd(m);
          if ((sa < 0) == (sm < 0)) {
            a = m;
            sa = sm;
          } else {
            b = m;
          }
        }
        roots.push_back(0.5 * (a + b));
      }
      u0 = u1;
      s0 = s1;
    }
    if (fabs(s0) <= tol && (roots.empty() || fabs(roots.back() - u0) > 1e-9 * (l - f))) roots.push_back(u0);
    if (!allIn)
      for (double u : roots) cross.push(pointTangent(c, u));
  }
  r.set("crossings", std::move(cross));
  if (const JV* jn = q.get("near")) {
    const gp_Pnt p = pnt(*jn);
    TopoDS_Vertex v = BRepBuilderAPI_MakeVertex(p).Vertex();
    BRepExtrema_DistShapeShape dd(v, E);
    if (!dd.IsDone() || dd.NbSolution() < 1) throw OcctError("could not find the nearest point on the edge");
    double u = f;
    if (dd.SupportTypeShape2(1) == BRepExtrema_IsOnEdge) dd.ParOnEdgeS2(1, u);
    else {
      const gp_Pnt hit = dd.PointOnShape2(1);
      u = hit.Distance(pf) <= hit.Distance(pl) ? f : l;
    }
    JV nr = pointTangent(c, u);
    nr.set("distance", dd.Value());
    r.set("nearest", std::move(nr));
  }
  return r;
}

// ------------------------------------------------------------------ API 5 ---
// P4b: copies of a shape under rigid transforms or a mirror (patterns), and the sketch's
// links to the model: edges and vertices projected onto a sketch plane, a body's
// silhouette seen along the plane's normal, and the section of bodies by the plane.
// Curves come back in the plane's own coordinates as PlaneCurve (kernel-protocol.ts).

// A transform: {matrix: [r00 r01 r02 tx r10 r11 r12 ty r20 r21 r22 tz]} (a rotation, or a
// rotation times -1 for a mirror; no scale).
gp_Trsf trsfOf(const JV& t) {
  const JV& m = t.req("matrix");
  if (!m.isArr() || m.size() != 12) throw InputError("a transform needs a 12-number matrix (3 rows of rotation and translation)");
  double a[12];
  for (int i = 0; i < 12; ++i) a[i] = m[i].num();
  // Orthonormal rows, determinant +1 or -1.
  for (int i = 0; i < 3; ++i)
    for (int j = 0; j < 3; ++j) {
      const double d = a[4 * i] * a[4 * j] + a[4 * i + 1] * a[4 * j + 1] + a[4 * i + 2] * a[4 * j + 2];
      if (fabs(d - (i == j ? 1.0 : 0.0)) > 1e-9) throw InputError("a transform must be a rotation or a mirror (orthonormal, no scale)");
    }
  gp_Trsf tr;
  try {
    tr.SetValues(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8], a[9], a[10], a[11]);
  } catch (const Standard_Failure& e) {
    throw InputError("the transform cannot be used: " + failureText(e));
  }
  return tr;
}

// Copies of a shape, one per transform: {id, transforms: [{matrix}]} -> {ids, faces (per copy),
// valid (per copy), maps}. A copy keeps its source's face, edge and vertex numbering
// (maps[k] is null); when OCCT renumbered a mirrored copy, maps[k][i] is the copy's face index
// of source face i. The source is never changed. Every copy is checked (BRepCheck) unless
// check:false.
JV opCopies(const JV& q) {
  const int sid = idParam(q.req("id"), "id");
  const JV& jt = q.req("transforms");
  if (!jt.isArr()) throw InputError("transforms must be an array");
  if (jt.size() > 10000) throw InputError("at most 10,000 copies in one call");
  const TopoDS_Shape& src = shapeOf(sid);
  Indexed& six = indexOf(sid);
  const bool check = q.boolean("check", true);
  JV ids = JV::arr(), faces = JV::arr(), valid = JV::arr(), maps = JV::arr(), reasons = JV::arr();
  bool allValid = true;
  std::vector<int> made;
  try {
    for (auto& t : jt.items()) {
      const gp_Trsf tr = trsfOf(t);
      // A rigid move only places the same topology (a Location); a mirror rebuilds the
      // geometry. Copy:true makes every copy independent of its source either way.
      BRepBuilderAPI_Transform bt(src, tr, Standard_True);
      if (!bt.IsDone()) throw OcctError("copying the shape failed");
      const TopoDS_Shape out = bt.Shape();
      const int id = putShape(out);
      made.push_back(id);
      Indexed& oix = indexOf(id);
      bool same = oix.f.Extent() == six.f.Extent();
      JV map = JV::arr();
      for (int i = 1; i <= six.f.Extent(); ++i) {
        const TopoDS_Shape m = bt.ModifiedShape(six.f(i));
        const int k = oix.f.FindIndex(m);
        if (k != i) same = false;
        map.push(k - 1);
      }
      ids.push(id);
      faces.push(oix.f.Extent());
      maps.push(same ? JV() : std::move(map));
      if (check) {
        const Validity v = analyse(out);
        valid.push(v.valid);
        reasons.push(v.valid ? JV() : JV(v.reason));
        if (!v.valid) allValid = false;
      }
    }
  } catch (...) {
    for (int id : made) g_store.erase(id);
    throw;
  }
  JV r = JV::obj();
  r.set("ids", std::move(ids));
  r.set("faces", std::move(faces));
  r.set("maps", std::move(maps));
  if (check) {
    r.set("valid", std::move(valid));
    r.set("reasons", std::move(reasons));
    r.set("all_valid", allValid);
  } else {
    r.set("checked", false);
  }
  return r;
}

// --- curves in a plane's coordinates -------------------------------------------------

JV uvJson(const gp_Pnt2d& p) {
  JV a = JV::arr();
  a.push(p.X());
  a.push(p.Y());
  return a;
}

double degOf(double rad) { return rad / kDeg; }

// {cubic: true} on project / section / silhouette: every B-spline comes back non-rational and of
// degree 3 (an approximation within the op's tolerance where it was not one), as the sketch's
// splines are (SKETCH's K1: no weights). Set for the length of one op.
bool g_cubicSplines = false;
double g_cubicTol = 1e-6;
struct CubicScope {
  CubicScope(const JV& q, double tol) {
    g_cubicSplines = q.boolean("cubic", false);
    g_cubicTol = tol;
  }
  ~CubicScope() { g_cubicSplines = false; }
};

// A 2D B-spline as PlaneCurve JSON.
JV bsplineJson(Handle(Geom2d_BSplineCurve) b) {
  if (b->IsPeriodic()) b->SetNotPeriodic();
  if (g_cubicSplines && (b->IsRational() || b->Degree() > 3)) {
    Handle(Geom2d_BSplineCurve) c3;
    const double t = std::max(g_cubicTol, 1e-9);
    // C1 (a cubic cannot be asked for C2 here: OCCT raises the degree to 5 for it).
    try {
      Geom2dConvert_ApproxCurve ap(b, t, GeomAbs_C1, 400, 3);
      if (ap.HasResult() && ap.MaxError() <= 10 * t && ap.Curve()->Degree() <= 3 && !ap.Curve()->IsRational()) c3 = ap.Curve();
    } catch (const Standard_Failure&) {
    }
    if (c3.IsNull()) {
      // Fit a C2 cubic through dense points of the curve (a conic's rational form can be C0 in
      // its parameter, which the approximation above refuses).
      const double f = b->FirstParameter(), l = b->LastParameter();
      const bool closed = b->StartPoint().Distance(b->EndPoint()) <= t;
      for (int n : {64, 128, 256, 512}) {
        const int m = closed ? n : n + 1;  // a closed curve: the seam point once (periodic)
        Handle(TColgp_HArray1OfPnt2d) pts = new TColgp_HArray1OfPnt2d(1, m);
        for (int k = 0; k < m; ++k) pts->SetValue(k + 1, b->Value(f + (l - f) * k / n));
        try {
          Geom2dAPI_Interpolate in(pts, closed ? Standard_True : Standard_False, 1e-9);
          in.Perform();
          if (!in.IsDone()) continue;
          Handle(Geom2d_BSplineCurve) cand = in.Curve();
          if (cand->IsPeriodic()) cand->SetNotPeriodic();
          // Checked between the samples.
          double err = 0;
          for (int k = 0; k < 4 * n; ++k) {
            const gp_Pnt2d p = b->Value(f + (l - f) * (k + 0.5) / (4 * n));
            Geom2dAPI_ProjectPointOnCurve pr(p, cand);
            if (pr.NbPoints() > 0) err = std::max(err, pr.LowerDistance());
          }
          c3 = cand;
          if (err <= 10 * t) break;
        } catch (const Standard_Failure&) {
        }
      }
    }
    if (c3.IsNull() || c3->IsRational() || c3->Degree() > 3) throw OcctError("could not turn a curve into a cubic spline");
    b = c3;
  }
  if (g_cubicSplines && b->Degree() < 3) b->IncreaseDegree(3);
  JV o = JV::obj();
  o.set("kind", "bspline");
  o.set("degree", b->Degree());
  JV poles = JV::arr(), knots = JV::arr(), mults = JV::arr();
  for (int i = 1; i <= b->NbPoles(); ++i) poles.push(uvJson(b->Pole(i)));
  for (int i = 1; i <= b->NbKnots(); ++i) {
    knots.push(b->Knot(i));
    mults.push(b->Multiplicity(i));
  }
  o.set("poles", std::move(poles));
  o.set("knots", std::move(knots));
  o.set("mults", std::move(mults));
  if (b->IsRational()) {
    JV w = JV::arr();
    for (int i = 1; i <= b->NbPoles(); ++i) w.push(b->Weight(i));
    o.set("weights", std::move(w));
  }
  return o;
}

// The part [f, l] of a 2D curve (in the plane's u/v), run from f to l (or l to f with rev), as
// PlaneCurve JSON: a line, an arc or a circle when it is one, a point or a line when it
// collapsed (a line seen end-on, a circle seen edge-on), else a B-spline (exact for conics,
// rational; an approximation within 1e-6 of the extent otherwise).
JV planeCurve(const Handle(Geom2d_Curve)& c0, double f, double l, bool rev, double tol) {
  Handle(Geom2d_Curve) c = c0;
  while (true) {
    Handle(Geom2d_TrimmedCurve) t = Handle(Geom2d_TrimmedCurve)::DownCast(c);
    if (t.IsNull()) break;
    c = t->BasisCurve();
  }
  // Collapsed: every sample within tol of one point, or of one line.
  {
    std::vector<gp_Pnt2d> s;
    for (int k = 0; k <= 16; ++k) s.push_back(c->Value(f + (l - f) * k / 16.0));
    double spread = 0;
    for (auto& p : s) spread = std::max(spread, p.Distance(s[0]));
    if (spread <= tol) {
      JV o = JV::obj();
      o.set("kind", "point");
      o.set("p", uvJson(s[0]));
      return o;
    }
    if (!c->IsKind(STANDARD_TYPE(Geom2d_Line))) {
      // The farthest pair spans the line; all samples near it -> a segment.
      gp_Pnt2d A = s[0], B = s[0];
      double best = -1;
      for (auto& p : s)
        for (auto& q2 : s)
          if (p.Distance(q2) > best) {
            best = p.Distance(q2);
            A = p;
            B = q2;
          }
      gp_Vec2d d(A, B);
      d.Normalize();
      bool straight = true;
      for (int k = 0; k <= 64 && straight; ++k) {
        const gp_Pnt2d p = c->Value(f + (l - f) * k / 64.0);
        if (fabs(gp_Vec2d(A, p).Crossed(d)) > tol) straight = false;
      }
      if (straight) {
        // Extent along d of the curve (dense samples).
        double lo = 1e300, hi = -1e300;
        for (int k = 0; k <= 256; ++k) {
          const double s1 = gp_Vec2d(A, c->Value(f + (l - f) * k / 256.0)).Dot(d);
          lo = std::min(lo, s1);
          hi = std::max(hi, s1);
        }
        JV o = JV::obj();
        o.set("kind", "line");
        const gp_Pnt2d P0(A.X() + d.X() * lo, A.Y() + d.Y() * lo), P1(A.X() + d.X() * hi, A.Y() + d.Y() * hi);
        o.set("a", uvJson(rev ? P1 : P0));
        o.set("b", uvJson(rev ? P0 : P1));
        return o;
      }
    }
  }
  if (c->IsKind(STANDARD_TYPE(Geom2d_Line))) {
    JV o = JV::obj();
    o.set("kind", "line");
    o.set("a", uvJson(c->Value(rev ? l : f)));
    o.set("b", uvJson(c->Value(rev ? f : l)));
    return o;
  }
  if (c->IsKind(STANDARD_TYPE(Geom2d_Circle))) {
    Handle(Geom2d_Circle) ci = Handle(Geom2d_Circle)::DownCast(c);
    const gp_Circ2d cc = ci->Circ2d();
    JV o = JV::obj();
    if (fabs((l - f) - kTwoPi) <= 1e-9 || l - f > kTwoPi) {
      o.set("kind", "circle");
      o.set("c", uvJson(cc.Location()));
      o.set("r", cc.Radius());
      return o;
    }
    const gp_Pnt2d ps = c->Value(rev ? l : f), pe = c->Value(rev ? f : l);
    const gp_Pnt2d C = cc.Location();
    o.set("kind", "arc");
    o.set("c", uvJson(C));
    o.set("r", cc.Radius());
    o.set("a0", degOf(atan2(ps.Y() - C.Y(), ps.X() - C.X())));
    o.set("a1", degOf(atan2(pe.Y() - C.Y(), pe.X() - C.X())));
    // The circle's own sense, turned when run backwards.
    o.set("ccw", cc.IsDirect() != rev);
    return o;
  }
  Handle(Geom2d_BSplineCurve) b;
  try {
    if (c->IsKind(STANDARD_TYPE(Geom2d_BSplineCurve))) {
      b = Handle(Geom2d_BSplineCurve)::DownCast(c->Copy());
      if (b->IsPeriodic()) {
        if (l - f < b->Period() - 1e-12) b->Segment(f, l);
        b->SetNotPeriodic();
      } else if (f > b->FirstParameter() + 1e-12 || l < b->LastParameter() - 1e-12) {
        b->Segment(f, l);
      }
    } else {
      Handle(Geom2d_TrimmedCurve) tc = new Geom2d_TrimmedCurve(c, f, l);
      if (c->IsKind(STANDARD_TYPE(Geom2d_Conic)) || c->IsKind(STANDARD_TYPE(Geom2d_BezierCurve))) {
        b = Geom2dConvert::CurveToBSplineCurve(tc);
      } else {
        Geom2dConvert_ApproxCurve ap(tc, std::max(tol * 0.1, 1e-9), GeomAbs_C2, 64, 8);
        if (!ap.HasResult()) throw OcctError("could not turn a curve into a spline");
        b = ap.Curve();
      }
    }
  } catch (const Standard_Failure& e) {
    throw OcctError("could not turn a curve into a spline: " + failureText(e));
  }
  if (rev) b->Reverse();
  return bsplineJson(b);
}

// A 3D curve that lies in plane `pl`, as a 2D curve in the plane's u/v.
Handle(Geom2d_Curve) inPlane2d(const Handle(Geom_Curve)& c3, const gp_Ax3& ax) {
  return GeomAPI::To2d(c3, gp_Pln(ax));
}

// The 3D curve of an edge with its location applied, and its range.
Handle(Geom_Curve) edgeCurve(const TopoDS_Edge& e, double& f, double& l) {
  TopLoc_Location loc;
  Handle(Geom_Curve) c = BRep_Tool::Curve(e, loc, f, l);
  if (c.IsNull()) return c;
  if (!loc.IsIdentity()) c = Handle(Geom_Curve)::DownCast(c->Transformed(loc.Transformation()));
  return c;
}

// An edge projected along the plane normal onto the plane, as PlaneCurve JSON (run in the
// edge's own orientation when `oriented`).
JV projectEdge(const TopoDS_Edge& e, const gp_Ax3& ax, double tol, bool oriented) {
  double f, l;
  Handle(Geom_Curve) c3 = edgeCurve(e, f, l);
  if (c3.IsNull() || BRep_Tool::Degenerated(e)) {
    TopoDS_Vertex v1, v2;
    TopExp::Vertices(e, v1, v2);
    if (v1.IsNull()) return JV();
    JV o = JV::obj();
    o.set("kind", "point");
    gp_Vec v(ax.Location(), BRep_Tool::Pnt(v1));
    o.set("p", uvJson(gp_Pnt2d(v.Dot(gp_Vec(ax.XDirection().XYZ())), v.Dot(gp_Vec(ax.YDirection().XYZ())))));
    return o;
  }
  const bool rev = oriented && e.Orientation() == TopAbs_REVERSED;
  Handle(Geom_Plane) gpl = new Geom_Plane(ax);
  // A curve seen end-on (a line along the normal) collapses: GeomProjLib refuses it, so the
  // collapsed cases are found on samples first (planeCurve does it on the 2D curve too).
  auto to2 = [&](const gp_Pnt& p) {
    gp_Vec v(ax.Location(), p);
    return gp_Pnt2d(v.Dot(gp_Vec(ax.XDirection().XYZ())), v.Dot(gp_Vec(ax.YDirection().XYZ())));
  };
  {
    double spread = 0;
    const gp_Pnt2d s0 = to2(c3->Value(f));
    for (int k = 1; k <= 16; ++k) spread = std::max(spread, to2(c3->Value(f + (l - f) * k / 16.0)).Distance(s0));
    if (spread <= tol) {
      JV o = JV::obj();
      o.set("kind", "point");
      o.set("p", uvJson(s0));
      return o;
    }
  }
  Handle(Geom_Curve) pc;
  try {
    pc = GeomProjLib::ProjectOnPlane(new Geom_TrimmedCurve(c3, f, l), gpl, ax.Direction(), Standard_True);
  } catch (const Standard_Failure&) {
    pc.Nullify();
  }
  if (pc.IsNull()) {
    // Fall back on a fitted spline through projected samples (never a silent drop).
    const int n = 64;
    TColgp_Array1OfPnt2d pts(1, n + 1);
    for (int k = 0; k <= n; ++k) pts.SetValue(k + 1, to2(c3->Value(f + (l - f) * k / n)));
    Geom2dAPI_PointsToBSpline fit(pts, 3, 8, GeomAbs_C2, tol);
    if (!fit.IsDone()) throw OcctError("could not project an edge onto the plane");
    Handle(Geom2d_BSplineCurve) b = fit.Curve();
    return planeCurve(b, b->FirstParameter(), b->LastParameter(), rev, tol);
  }
  Handle(Geom2d_Curve) c2 = inPlane2d(pc, ax);
  double pf = pc->FirstParameter(), pl2 = pc->LastParameter();
  return planeCurve(c2, pf, pl2, rev, tol);
}

double scaleOfShape(const TopoDS_Shape& s) {
  Bnd_Box b;
  BRepBndLib::Add(s, b, false);
  if (b.IsVoid()) return 1;
  double x0, y0, z0, x1, y1, z1;
  b.Get(x0, y0, z0, x1, y1, z1);
  return std::max(1.0, std::max({fabs(x0), fabs(y0), fabs(z0), fabs(x1), fabs(y1), fabs(z1), x1 - x0, y1 - y0, z1 - z0}));
}

// project: {plane, items: [{id, face? (+ all_wires?), edge?, vertex?}], tol?} -> {items: [{curves:
// (PlaneCurve & {src})[], message?}]}: each edge's curve projected along the plane normal; a
// face gives the edges of its outer wire (all its wires with all_wires); a vertex a point.
JV opProject(const JV& q) {
  const gp_Ax3 ax = sketchFrame(q.req("plane"));
  CubicScope cubic(q, q.num("tol", 1e-6));
  const JV& items = q.req("items");
  if (!items.isArr()) throw InputError("items must be an array");
  JV out = JV::arr();
  for (auto& it : items.items()) {
    const int sid = idParam(it.req("id"), "id");
    const double tol = q.num("tol", 1e-7 * scaleOfShape(shapeOf(sid)));
    JV curves = JV::arr();
    JV one = JV::obj();
    Indexed& ix = indexOf(sid);
    auto addEdge = [&](const TopoDS_Edge& e, bool oriented) {
      JV c = projectEdge(e, ax, tol, oriented);
      if (c.isNull()) return;
      JV src = JV::obj();
      TopoDS_Edge ef = e;
      ef.Orientation(TopAbs_FORWARD);
      src.set("edge", ix.e.FindIndex(ef) - 1);
      c.set("src", std::move(src));
      curves.push(std::move(c));
    };
    if (it.has("vertex")) {
      Indexed& ixv = ix;
      const int i = (int)it.num("vertex");
      if (i < 0 || i >= ixv.v.Extent()) throw InputError("vertex index " + std::to_string(i) + " out of range");
      gp_Vec v(ax.Location(), BRep_Tool::Pnt(TopoDS::Vertex(ixv.v(i + 1))));
      JV c = JV::obj();
      c.set("kind", "point");
      c.set("p", uvJson(gp_Pnt2d(v.Dot(gp_Vec(ax.XDirection().XYZ())), v.Dot(gp_Vec(ax.YDirection().XYZ())))));
      JV src = JV::obj();
      src.set("vertex", i);
      c.set("src", std::move(src));
      curves.push(std::move(c));
    } else if (it.has("edge")) {
      addEdge(edgeAt(sid, it.req("edge")), false);
      if (curves.size() == 0) one.set("message", "the edge has no curve to project");
    } else if (it.has("face")) {
      const TopoDS_Face F = faceAt(sid, it.req("face"));
      const bool all = it.boolean("all_wires", false);
      const TopoDS_Wire outer = BRepTools::OuterWire(F);
      for (TopoDS_Iterator wi(F); wi.More(); wi.Next()) {
        if (wi.Value().ShapeType() != TopAbs_WIRE) continue;
        if (!all && !outer.IsNull() && !wi.Value().IsSame(outer)) continue;
        for (BRepTools_WireExplorer we(TopoDS::Wire(wi.Value()), F); we.More(); we.Next()) {
          if (BRep_Tool::Degenerated(we.Current())) continue;
          TopoDS_Edge e = we.Current();
          e.Orientation(we.Orientation());
          addEdge(e, true);
        }
      }
      if (curves.size() == 0) one.set("message", "the face has no edges to project");
    } else {
      throw InputError("each item needs a face, an edge or a vertex");
    }
    one.set("curves", std::move(curves));
    out.push(std::move(one));
  }
  JV r = JV::obj();
  r.set("items", std::move(out));
  return r;
}

// Edges chained head to tail into wires (ShapeAnalysis_FreeBounds), each as {closed, edges in order}.
struct Chain {
  bool closed = false;
  std::vector<TopoDS_Edge> edges;  // oriented as run
};

std::vector<Chain> chainEdges(const std::vector<TopoDS_Edge>& edges, double tol) {
  std::vector<Chain> out;
  if (edges.empty()) return out;
  Handle(TopTools_HSequenceOfShape) seq = new TopTools_HSequenceOfShape();
  for (auto& e : edges) seq->Append(e);
  Handle(TopTools_HSequenceOfShape) wires = new TopTools_HSequenceOfShape();
  ShapeAnalysis_FreeBounds::ConnectEdgesToWires(seq, tol, Standard_False, wires);
  for (int i = 1; i <= wires->Length(); ++i) {
    const TopoDS_Wire w = TopoDS::Wire(wires->Value(i));
    Chain ch;
    for (BRepTools_WireExplorer we(w); we.More(); we.Next()) {
      TopoDS_Edge e = we.Current();
      e.Orientation(we.Orientation());
      ch.edges.push_back(e);
    }
    if (ch.edges.empty())
      for (TopExp_Explorer ex(w, TopAbs_EDGE); ex.More(); ex.Next()) ch.edges.push_back(TopoDS::Edge(ex.Current()));
    TopoDS_Vertex v1, v2;
    TopExp::Vertices(w, v1, v2);
    ch.closed = BRep_Tool::IsClosed(w) || (!v1.IsNull() && !v2.IsNull() && BRep_Tool::Pnt(v1).Distance(BRep_Tool::Pnt(v2)) <= tol);
    out.push_back(std::move(ch));
  }
  return out;
}

// An edge lying in the plane as PlaneCurve JSON, run in its orientation.
JV inPlaneEdge(const TopoDS_Edge& e, const gp_Ax3& ax, double tol) { return projectEdge(e, ax, tol, true); }

// section: {plane, ids, tol?} -> {bodies: [{id, loops: [{closed, curves: (PlaneCurve & {src:
// {face}})[]}]}]}: where the (infinite) plane cuts each body, chained head to tail.
JV opSection(const JV& q) {
  const gp_Ax3 ax = sketchFrame(q.req("plane"));
  CubicScope cubic(q, q.num("tol", 1e-6));
  const JV& ids = q.req("ids");
  if (!ids.isArr()) throw InputError("ids must be an array");
  JV bodies = JV::arr();
  for (auto& jid : ids.items()) {
    const int sid = idParam(jid, "id");
    const TopoDS_Shape& S = shapeOf(sid);
    const double tol = q.num("tol", 1e-7 * scaleOfShape(S));
    Indexed& ix = indexOf(sid);
    BRepAlgoAPI_Section sec(S, gp_Pln(ax), Standard_False);
    sec.ComputePCurveOn1(Standard_False);
    sec.Approximation(Standard_True);
    sec.SetRunParallel(false);
    sec.Build();
    if (!sec.IsDone() || sec.HasErrors()) throw OcctError("the section failed: " + algoErrors(sec));
    std::vector<TopoDS_Edge> edges;
    for (TopExp_Explorer ex(sec.Shape(), TopAbs_EDGE); ex.More(); ex.Next()) edges.push_back(TopoDS::Edge(ex.Current()));
    JV loops = JV::arr();
    for (auto& ch : chainEdges(edges, std::max(tol * 10, 1e-6))) {
      JV curves = JV::arr();
      for (auto& e : ch.edges) {
        JV c = inPlaneEdge(e, ax, tol);
        if (c.isNull()) continue;
        TopoDS_Shape F;
        JV src = JV::obj();
        TopoDS_Edge ef = e;
        ef.Orientation(TopAbs_FORWARD);
        if (sec.HasAncestorFaceOn1(ef, F) || sec.HasAncestorFaceOn1(e, F)) src.set("face", ix.f.FindIndex(F) - 1);
        c.set("src", std::move(src));
        curves.push(std::move(c));
      }
      if (curves.size() == 0) continue;
      JV lp = JV::obj();
      lp.set("closed", ch.closed);
      lp.set("curves", std::move(curves));
      loops.push(std::move(lp));
    }
    JV b = JV::obj();
    b.set("id", sid);
    b.set("loops", std::move(loops));
    bodies.push(std::move(b));
  }
  JV r = JV::obj();
  r.set("bodies", std::move(bodies));
  return r;
}

// Consecutive lines of a loop that continue each other (a split left by HLR or the
// splitter at a seam) merged into one; the loop's last and first too.
JV mergeCollinear(const JV& curves, double tol) {
  std::vector<JV> out;
  auto isLine = [](const JV& c) { return c.isObj() && c.str("kind", "") == "line"; };
  auto pt = [](const JV& a) { return gp_Pnt2d(a[0].num(), a[1].num()); };
  auto joins = [&](const JV& x, const JV& y) {
    if (!isLine(x) || !isLine(y)) return false;
    const gp_Pnt2d a = pt(x.req("a")), b = pt(x.req("b")), c = pt(y.req("a")), d = pt(y.req("b"));
    if (b.Distance(c) > tol) return false;
    const gp_Vec2d u(a, b), w(c, d);
    if (u.Magnitude() <= tol || w.Magnitude() <= tol) return true;
    return fabs(u.Crossed(w)) <= tol * (u.Magnitude() + w.Magnitude()) && u.Dot(w) > 0;
  };
  for (auto& c : curves.items()) {
    if (!out.empty() && joins(out.back(), c)) {
      out.back().set("b", c.req("b"));
      continue;
    }
    out.push_back(c);
  }
  if (out.size() > 1 && joins(out.back(), out.front())) {
    out.front().set("a", out.back().req("a"));
    out.pop_back();
  }
  JV r = JV::arr();
  for (auto& c : out) r.push(c);
  return r;
}

// silhouette: {plane, ids, tol?} -> {loops: [{curves: PlaneCurve[], hole}], empty}: the outline of
// what the bodies cover seen along the plane normal. HLR (HLRBRep_Algo) gives the visible sharp
// edges and the outlines in the plane's coordinates; they split a face covering them all; each
// piece whose inside point lies over a body (a line along the normal through it meets one) is
// covered; the covered pieces are merged and their wires are the loops (the outer ones and the
// holes one can see through).
JV opSilhouette(const JV& q) {
  const gp_Ax3 ax = sketchFrame(q.req("plane"));
  const JV& ids = q.req("ids");
  if (!ids.isArr() || ids.size() == 0) throw InputError("silhouette needs at least one body");
  std::vector<TopoDS_Shape> shapes;
  double scale = 1;
  for (auto& jid : ids.items()) {
    shapes.push_back(shapeOf(idParam(jid, "id")));
    scale = std::max(scale, scaleOfShape(shapes.back()));
  }
  const double tol = q.num("tol", 1e-7 * scale);
  CubicScope cubic(q, std::max(tol * 10, 1e-6 * scale));
  const gp_Ax2 cs(ax.Location(), ax.Direction(), ax.XDirection());
  Handle(HLRBRep_Algo) algo = new HLRBRep_Algo();
  for (auto& s : shapes) algo->Add(s);
  algo->Projector(HLRAlgo_Projector(cs));
  algo->Update();
  algo->Hide();
  HLRBRep_HLRToShape hs(algo);
  // HLR's results lie in the projector's own plane: (x, y, 0) with x along xdir, y along normal x xdir.
  std::vector<TopoDS_Edge> hlr;
  for (const TopoDS_Shape& part : {hs.VCompound(), hs.OutLineVCompound(), hs.Rg1LineVCompound(), hs.HCompound(), hs.OutLineHCompound()}) {
    if (part.IsNull()) continue;
    for (TopExp_Explorer ex(part, TopAbs_EDGE); ex.More(); ex.Next()) hlr.push_back(TopoDS::Edge(ex.Current()));
  }
  JV r = JV::obj();
  JV loops = JV::arr();
  if (hlr.empty()) {
    r.set("loops", std::move(loops));
    r.set("empty", true);
    return r;
  }
  // The HLR edges moved onto the sketch plane (projector coordinates -> the plane's frame).
  gp_Trsf toPlane;
  toPlane.SetTransformation(gp_Ax3(cs), gp_Ax3(gp::XOY()));
  BRep_Builder bb;
  TopoDS_Compound all;
  bb.MakeCompound(all);
  for (auto& e : hlr) {
    TopoDS_Edge e2 = e;
    BRepLib::BuildCurve3d(e2);
    bb.Add(all, e2);
  }
  TopoDS_Shape onPlane = BRepBuilderAPI_Transform(all, toPlane, Standard_True).Shape();
  TopTools_ListOfShape tools;
  double u0 = 1e300, v0 = 1e300, u1 = -1e300, v1 = -1e300;
  {
    Bnd_Box b;
    BRepBndLib::Add(onPlane, b, false);
    for (TopExp_Explorer ex(onPlane, TopAbs_EDGE); ex.More(); ex.Next()) tools.Append(ex.Current());
    double x0, y0, z0, x1, y1, z1;
    b.Get(x0, y0, z0, x1, y1, z1);
    for (double x : {x0, x1})
      for (double y : {y0, y1})
        for (double z : {z0, z1}) {
          gp_Vec v(ax.Location(), gp_Pnt(x, y, z));
          const double u = v.Dot(gp_Vec(ax.XDirection().XYZ())), w = v.Dot(gp_Vec(ax.YDirection().XYZ()));
          u0 = std::min(u0, u);
          v0 = std::min(v0, w);
          u1 = std::max(u1, u);
          v1 = std::max(v1, w);
        }
  }
  const double half = std::max(u1 - u0, v1 - v0) + 1.0;
  const double cu = 0.5 * (u0 + u1), cv = 0.5 * (v0 + v1);
  TopoDS_Face cover = BRepBuilderAPI_MakeFace(gp_Pln(ax), cu - half, cu + half, cv - half, cv + half).Face();
  BRepAlgoAPI_Splitter sp;
  TopTools_ListOfShape args;
  args.Append(cover);
  sp.SetArguments(args);
  sp.SetTools(tools);
  sp.SetRunParallel(false);
  sp.SetNonDestructive(true);
  sp.SetFuzzyValue(std::max(tol * 10, 1e-6 * scale));
  sp.Build();
  if (sp.HasErrors()) throw OcctError("finding the silhouette failed: " + algoErrors(sp));
  // The cover's own boundary edges: a piece touching them is outside.
  TopTools_IndexedMapOfShape coverEdges;
  {
    TopTools_IndexedMapOfShape ce;
    TopExp::MapShapes(cover, TopAbs_EDGE, ce);
    for (int i = 1; i <= ce.Extent(); ++i) {
      const TopTools_ListOfShape& mods = sp.Modified(ce(i));
      for (TopTools_ListIteratorOfListOfShape it(mods); it.More(); it.Next()) coverEdges.Add(it.Value());
      if (mods.IsEmpty()) coverEdges.Add(ce(i));
    }
  }
  std::vector<IntCurvesFace_ShapeIntersector*> hits;
  for (auto& s : shapes) {
    auto* ix = new IntCurvesFace_ShapeIntersector();
    ix->Load(s, tol);
    hits.push_back(ix);
  }
  auto covered = [&](const gp_Pnt& p) {
    const gp_Lin line(p, ax.Direction());
    for (auto* ix : hits) {
      ix->Perform(line, -1e100, 1e100);
      if (ix->IsDone() && ix->NbPnt() > 0) return true;
    }
    return false;
  };
  TopoDS_Shell shell;
  bb.MakeShell(shell);
  int nCovered = 0;
  try {
    for (TopExp_Explorer fx(sp.Shape(), TopAbs_FACE); fx.More(); fx.Next()) {
      const TopoDS_Face& F = TopoDS::Face(fx.Current());
      bool outer = false;
      for (TopExp_Explorer ex(F, TopAbs_EDGE); ex.More() && !outer; ex.Next())
        if (coverEdges.FindIndex(ex.Current())) outer = true;
      if (outer) continue;
      // A point inside: the centroid of the largest triangle of its mesh.
      BRepMesh_IncrementalMesh m(F, 1e-3 * half, Standard_False, 0.35, Standard_False);
      TopLoc_Location loc;
      Handle(Poly_Triangulation) tri = BRep_Tool::Triangulation(F, loc);
      if (tri.IsNull() || tri->NbTriangles() == 0) continue;
      double best = -1;
      gp_Pnt in;
      for (int k = 1; k <= tri->NbTriangles(); ++k) {
        int a, b, c;
        tri->Triangle(k).Get(a, b, c);
        gp_Pnt pa = tri->Node(a), pb = tri->Node(b), pc = tri->Node(c);
        const double ar = gp_Vec(pa, pb).Crossed(gp_Vec(pa, pc)).Magnitude();
        if (ar > best) {
          best = ar;
          in = gp_Pnt((pa.XYZ() + pb.XYZ() + pc.XYZ()) / 3.0);
          if (!loc.IsIdentity()) in.Transform(loc.Transformation());
        }
      }
      if (!covered(in)) continue;
      bb.Add(shell, F);
      ++nCovered;
    }
  } catch (...) {
    for (auto* ix : hits) delete ix;
    throw;
  }
  for (auto* ix : hits) delete ix;
  if (!nCovered) {
    r.set("loops", std::move(loops));
    r.set("empty", true);
    return r;
  }
  ShapeUpgrade_UnifySameDomain u(shell, Standard_True, Standard_True, Standard_False);
  u.Build();
  for (TopExp_Explorer fx(u.Shape(), TopAbs_FACE); fx.More(); fx.Next()) {
    const TopoDS_Face& F = TopoDS::Face(fx.Current());
    const TopoDS_Wire ow = BRepTools::OuterWire(F);
    for (TopoDS_Iterator wi(F); wi.More(); wi.Next()) {
      if (wi.Value().ShapeType() != TopAbs_WIRE) continue;
      JV curves = JV::arr();
      for (BRepTools_WireExplorer we(TopoDS::Wire(wi.Value()), F); we.More(); we.Next()) {
        TopoDS_Edge e = we.Current();
        e.Orientation(we.Orientation());
        JV c = inPlaneEdge(e, ax, tol);
        if (!c.isNull() && c.str("kind") != "point") curves.push(std::move(c));
      }
      curves = mergeCollinear(curves, std::max(tol * 10, 1e-9 * scale));
      if (curves.size() == 0) continue;
      JV lp = JV::obj();
      lp.set("hole", !wi.Value().IsSame(ow));
      lp.set("curves", std::move(curves));
      loops.push(std::move(lp));
    }
  }
  const bool none = loops.size() == 0;
  r.set("loops", std::move(loops));
  r.set("empty", none);
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
  if (op == "link_export") return opLinkExport(q);
  if (op == "press_pull") return opPressPull(q);
  if (op == "offset_faces") return opOffsetFaces(q);
  if (op == "combine") return opCombine(q);
  if (op == "measure") return opMeasure(q);
  if (op == "sketch_regions") return opSketchRegions(q);
  if (op == "extrude_regions") return opExtrudeRegions(q);
  if (op == "revolve_regions") return opRevolveRegions(q);
  if (op == "sweep_regions") return opSweepRegions(q);
  if (op == "loft_regions") return opLoftRegions(q);
  if (op == "extrude_face") return opExtrudeFace(q);
  if (op == "edge_eval") return opEdgeEval(q);
  if (op == "copies") return opCopies(q);
  if (op == "project") return opProject(q);
  if (op == "section") return opSection(q);
  if (op == "silhouette") return opSilhouette(q);
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
