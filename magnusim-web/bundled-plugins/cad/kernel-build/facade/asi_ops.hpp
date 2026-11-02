// Analysis Situs ops of the kernel facade (kernel API 8): fillet and drilled-hole recognition,
// and taking fillets off with a complete history. The interface uses OCCT and std types only;
// asi_ops.cpp is the one source file that sees Analysis Situs' headers and the OCCT 7.9
// compatibility header (kernel-build/asi/asi_occt79_compat.h), so its global HashCode / IsEqual
// helpers never reach facade.cpp. Each call answers a Refusal: an empty code is done, otherwise
// the code says whose fault it is ("input": the request or the shape, "occt": an algorithm could
// not do it, "internal": a bug, never a wrong answer) and `words` say why. facade.cpp turns them
// into its own errors and does the index checks, work copies, storing and validity.
// SPDX-License-Identifier: GPL-3.0-or-later
#ifndef MK_ASI_OPS_HPP
#define MK_ASI_OPS_HPP

#include <string>
#include <vector>

#include <BRepTools_History.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS_Shape.hxx>

namespace mkasi {

struct Refusal {
  std::string code;   // "" (done), "input", "occt" or "internal"
  std::string words;  // why, in words
  bool ok() const { return code.empty(); }
};

// One recognised fillet face. Indices are 0-based positions in the body's face map.
struct Blend {
  int face = -1;
  double r = 0;                 // Analysis Situs' own radius (one sample per face)
  double r_min = 0, r_max = 0;  // exact for cylinders, tori (the tube radius) and spheres;
                                // otherwise 1 / the largest principal curvature over a 5 x 5 grid
  int convex = -1;              // 1 convex, 0 concave, -1 mixed or not known
  std::string kind;             // "ordinary", "vertex", "cliff" or "uncertain"
  int chain = -1;               // index into Recognition::chains, -1 for none
};

struct Chain {
  std::vector<int> faces;  // sorted
  double r_min = 0, r_max = 0, length = 0;
};

// A recognised drilled hole: its faces (sorted), the narrowest and widest bore (2 x the
// smallest and largest cylinder radius; `sized` is false when it has no cylinder), and
// whether it goes through (no face of the hole closes its axis).
struct Hole {
  std::vector<int> faces;
  bool sized = false;
  double d_min = 0, d_max = 0;
  bool through = false;
};

struct Recognition {
  int faces = 0, solids = 0;
  std::vector<Blend> blends;  // sorted by face
  std::vector<Chain> chains;  // sorted by their smallest face
  std::vector<Hole> holes;    // sorted by their smallest face
  double aag_ms = 0, blends_ms = 0, holes_ms = 0;
};

struct RecognizeOptions {
  bool blends = true, holes = true;
  bool hardHoles = false;  // asiAlgo_RecognizeDrillHoles' "hard" mode (comparison only)
  double maxR = 0;         // RecognizeBlends' radius limit; 0 = the body's box diagonal (every fillet)
};

// Recognise the fillets and drilled holes of every solid of `body` (one fresh AAG per solid
// and per algorithm). `faces` is the body's face map (TopExp::MapShapes order).
Refusal recognize(const TopoDS_Shape& body, const TopTools_IndexedMapOfShape& faces, const RecognizeOptions& opts,
                  Recognition& out);

struct Suppression {
  TopoDS_Shape shape;                 // the result (a solid)
  Handle(BRepTools_History) history;  // every input face and edge: modified (all images), generated, removed
  int chains = 0;                     // chains SuppressBlendsInc took off
  double r = 0;                       // the largest picked fillet radius
  double max_r = 0;                   // the limit SuppressBlendsInc ran with: r x (1 + 1e-3)
  int asked = 0, removed = 0, left = 0;
  // The kernel's self-check (every count but `split` is 0 on a result that is returned).
  int split = 0;          // kept faces with more than one image
  int stale = 0;          // live history leaves that are not in the result
  int dropped = 0;        // input faces with no history record that are not in the result
  double recognize_ms = 0, suppress_ms = 0, history_ms = 0;
  // Analysis Situs' own ConvertToOcc read the facade's way, against our history (comparison).
  int occ_disagree = 0, occ_fewer_images = 0, occ_no_source = 0;
  // What SuppressBlendsInc was predicted to take before it ran (asi_ops.cpp, costCounts and
  // predictSuppressMs): the chains of the pick at R, the adjacency work of one graph build before
  // and after the picks are gone, the chains among and the picks that are free-form faces, the
  // prediction and the budget it was held to.
  int cost_chains = 0, cost_free_chains = 0, cost_free_picks = 0;
  double cost_pair_work = 0, cost_pair_work_after = 0, predicted_ms = 0, budget_ms = 0;
};

// The longest SuppressBlendsInc run suppress_blends starts, predicted from counts (asi_ops.cpp).
double suppressBudgetMs();

// suppress_blends' refusal of a run predicted over its budget: "taking 404 fillet faces off as
// fillets on a body of 810 faces would take about 20 s; Delete faces allows 1.4 s for taking
// fillets off as fillets". Below 10 s the time has one decimal and never reads at or under the
// budget ("about 1.5 s" for 1.42 s over 1.4 s).
std::string budgetWords(long long picks, long long faces, double predictedMs, double budgetMs);

// Take the picked fillets (0-based face indices of `body`) off its one solid with
// asiAlgo_SuppressBlendsInc. The pick must be every fillet up to the largest picked radius,
// checked against SuppressBlendsInc's own recognition, and its predicted run time must be within
// `budgetMs` (0 = suppressBudgetMs(); a caller may only lower it). `useConvertToOcc` (tests only)
// reports Analysis Situs' ConvertToOcc history instead of the all-leaves one; the self-check still
// runs.
Refusal suppressBlends(const TopoDS_Shape& body, const TopTools_IndexedMapOfShape& faces, const std::vector<int>& picks,
                       bool useConvertToOcc, double budgetMs, Suppression& out);

// The Analysis Situs release the kernel carries.
const char* version();

}  // namespace mkasi

#endif
