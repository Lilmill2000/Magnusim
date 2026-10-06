/**************************************************************************************************
* This library provides WebAssembly bindings for the FreeCAD's geometric solver library planegcs. *
* Copyright (C) 2023  Miroslav Šerý, Salusoft89 <miroslav.sery@salusoft89.cz>                     *
* Copyright (C) 2023  Jiří Hon, Salusoft89 <jiri.hon@salusoft89.cz>                               *
*                                                                                                 *
* This library is free software; you can redistribute it and/or                                   *
* modify it under the terms of the GNU Lesser General Public                                      *
* License as published by the Free Software Foundation; either                                    *
* version 2.1 of the License, or (at your option) any later version.                              *
*                                                                                                 *
* This library is distributed in the hope that it will be useful,                                 *
* but WITHOUT ANY WARRANTY; without even the implied warranty of                                  *
* MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU                               *
* Lesser General Public License for more details.                                                 *
*                                                                                                 *
* You should have received a copy of the GNU Lesser General Public                                *
* License along with this library; if not, write to the Free Software                             *
* Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA                    *
**************************************************************************************************/

#include <iostream>
#include <vector>
#include <unordered_map>
#include <stdexcept>
#include <cstdint>
#include "GCS.h"
#include "MagnusimSpline.h"
#include <emscripten.h>  

using namespace GCS;
using namespace std;

class GcsSystem : System

{
    public:
        vector<double *> p_params;
        vector<bool> is_fixed;

        GcsSystem() : System() {
            p_params = vector<double *>();
            is_fixed = vector<bool>();
        }

        int params_size()
        {
            return p_params.size();
        }

        double get_p_param(int i)
        {
            return *p_params[i];
        }

        void set_p_param(int i, double value, bool fixed)
        {
            *p_params[i] = value;
            is_fixed[i] = fixed;
        }

        int push_p_param(double value, bool fixed)
        {
            int index = p_params.size();
            p_params.push_back(new double(value));
            is_fixed.push_back(fixed);
            return index;
        }

        bool get_is_fixed(int i)
        {
            return is_fixed[i];
        }

        void set_max_iterations(int n) {
            maxIter = n;
        }

        int get_max_iterations() {
            return maxIter;
        }

        void set_covergence_threshold(double threshold) {
            convergence = threshold;
        }

        double get_convergence_threshold() {
            return convergence;
        }

        // an integer is used here because Enum didn't work properly
        int solve_system(int algorithm)
        {
            Algorithm alg = static_cast<Algorithm>(algorithm);
            vector<double *> solved_p_params;
            for (int i = 0; i < p_params.size(); ++i)
            {
                if (!is_fixed[i])
                {
                    solved_p_params.push_back(p_params[i]);
                }
            }

            if (this->debugMode == IterationLevel) {
                if (alg == DogLeg) {
                    EM_ASM({ console.log("Solving with DogLeg\n"); });
                } else if (alg == LevenbergMarquardt) {
                    EM_ASM({ console.log("Solving with LevenbergMarquardt\n"); });
                } else if (alg == BFGS) {
                    EM_ASM({ console.log("Solving with BFGS\n"); });
                }
            }
            // the second parameter doesn't influence anything
            return solve(solved_p_params, true, alg);
        }

        vector<double> get_p_params()
        {
            vector<double> p;
            for (int i = 0; i < p_params.size(); ++i)
            {
                p.push_back(*p_params[i]);
            }
            return p;
        }

        void clear_data()
        {
            for (int i = 0; i < p_params.size(); ++i)
            {
                delete p_params[i];
            }
            p_params.clear();
            is_fixed.clear();
            param_index.clear();
            clear();
        }

        void apply_solution()
        {
            applySolution();
        }

        int dof()
        {
            return dofsNumber();
        }

        bool has_conflicting()
        {
            return hasConflicting();
        }

        bool has_redundant()
        {
            return hasRedundant();
        }

        bool has_partially_redundant()
        {
            return hasPartiallyRedundant();
        }

        vector<int> get_conflicting()
        {
            vector<int> conflicting;
            getConflicting(conflicting);
            return conflicting;
        }

        vector<int> get_redundant()
        {
            vector<int> redundant;
            getRedundant(redundant);
            return redundant;
        }

        vector<int> get_partially_redundant()
        {
            vector<int> partially_redundant;
            getPartiallyRedundant(partially_redundant);
            return partially_redundant;
        }

        void clear_by_id(int id)
        {
            clearByTag(id);
        }


        /* ---- spike additions ---- */
        // Declares the free (non-fixed) parameters as the unknowns of the system.
        void declare_free_unknowns()
        {
            vector<double *> unknowns;
            unknowns.reserve(p_params.size());
            for (size_t i = 0; i < p_params.size(); ++i)
            {
                if (!is_fixed[i])
                {
                    unknowns.push_back(p_params[i]);
                }
            }
            declareUnknowns(unknowns);
        }

        // Declares the unknowns, stores the reference configuration, diagnoses the
        // system when its (tag >= 0) constraint set changed, and builds the subsystems.
        void init_solution(int algorithm)
        {
            declare_free_unknowns();
            initSolution(static_cast<Algorithm>(algorithm));
        }

        // Solves the prepared system from its reference configuration without
        // re-partitioning it (the per-move call of a drag).
        int solve_prepared(int algorithm)
        {
            return solve(true, static_cast<Algorithm>(algorithm));
        }

        // Forces a fresh QR diagnosis and rebuilds the subsystems. Returns the DOF count.
        int diagnose_fresh(int algorithm)
        {
            invalidatedDiagnosis();
            init_solution(algorithm);
            return dofsNumber();
        }

        int param_index_of(double *p)
        {
            if (param_index.size() != p_params.size())
            {
                param_index.clear();
                for (size_t i = 0; i < p_params.size(); ++i)
                {
                    param_index[p_params[i]] = static_cast<int>(i);
                }
            }
            auto it = param_index.find(p);
            return it == param_index.end() ? -1 : it->second;
        }

        // Indices (into p_params) of the parameters the last diagnosis found dependent,
        // i.e. not fixed by the constraints.
        // Magnusim (P4b fix 1): a point on a sketch spline at a free parameter (one call per coordinate).
        void add_constraint_point_on_affine_spline(int p_i, int u_i, vector<int> q_i, vector<double> w, int n_poles, vector<double> flat, int degree, int tagId, bool driving)
        {
            if (degree < 1 || degree > 8) throw std::invalid_argument("spline degree out of range");
            if ((int)w.size() != n_poles * (int)q_i.size()) throw std::invalid_argument("spline weights do not match");
            if ((int)flat.size() != n_poles + degree + 1) throw std::invalid_argument("spline knots do not match");
            vector<double*> q;
            for (int i : q_i) q.push_back(p_params[i]);
            Constraint* c = new ConstraintPointOnAffineSpline(p_params[p_i], p_params[u_i], q, w, n_poles, flat, degree);
            c->setTag(tagId);
            c->setDriving(driving);
            addConstraint(c);
        }

        vector<int> get_dependent_params()
        {
            vector<double *> dep;
            getDependentParams(dep);
            vector<int> out;
            out.reserve(dep.size());
            for (double *p : dep)
            {
                out.push_back(param_index_of(p));
            }
            return out;
        }

        // Dependent parameter groups, flattened with -1 separators.
        vector<int> get_dependent_param_groups()
        {
            std::vector<std::vector<double *>> groups;
            getDependentParamsGroups(groups);
            vector<int> out;
            for (auto &g : groups)
            {
                for (double *p : g)
                {
                    out.push_back(param_index_of(p));
                }
                out.push_back(-1);
            }
            return out;
        }

        // Copies every parameter value into a buffer and returns its address.
        int params_to_buffer()
        {
            param_out.resize(p_params.size());
            for (size_t i = 0; i < p_params.size(); ++i)
            {
                param_out[i] = *p_params[i];
            }
            return static_cast<int>(reinterpret_cast<uintptr_t>(param_out.data()));
        }

        // Returns the address of an input buffer of n doubles.
        int input_buffer(int n)
        {
            param_in.resize(n);
            return static_cast<int>(reinterpret_cast<uintptr_t>(param_in.data()));
        }

        // Sets parameters [first, first + n) from the input buffer (fixed flags unchanged).
        void params_from_buffer(int first, int n)
        {
            if (first < 0 || n < 0 || first + n > static_cast<int>(p_params.size()) || n > static_cast<int>(param_in.size()))
            {
                throw std::runtime_error("params_from_buffer: range outside the parameters");
            }
            for (int i = 0; i < n; ++i)
            {
                *p_params[first + i] = param_in[i];
            }
        }

        std::unordered_map<double *, int> param_index;
        vector<double> param_out;
        vector<double> param_in;
        // DogLeg Gauss-Newton step: 0 FullPivLU (GCS default), 1 LeastNormFullPivLU,
        // 2 LeastNormLdlt, 3 LeastNormSparseLdlt (spike patch)
        void set_dl_gauss_step(int step) { dogLegGaussStep = static_cast<DogLegGaussStep>(step); }
        int get_dl_gauss_step() { return static_cast<int>(dogLegGaussStep); }
        // Sparse SQP for drag solves of components with at least n parameters (0 = off)
        void set_sparse_sqp_min_params(int n) { sparseSQPMinParams = n; }
        /* ---- end of spike additions ---- */

        void set_debug_mode(int debug_mode)
        {
            DebugMode debug_mode_enum = static_cast<DebugMode>(debug_mode);
            this->debugMode = debug_mode_enum;
        }

        int get_debug_mode()
        {
            return this->debugMode;
        }

        /* make objects from params */
        Point make_point(int px_i, int py_i)
        {
            Point p;
            p.x = p_param_or_fail(px_i);
            p.y = p_param_or_fail(py_i);
            return p;
        }

        Line make_line(int p1x_i, int p1y_i, int p2x_i, int p2y_i)
        {
            Point p1 = make_point(p1x_i, p1y_i);
            Point p2 = make_point(p2x_i, p2y_i);

            Line l;
            l.p1 = p1;
            l.p2 = p2;

            return l;
        }

        Circle make_circle(int cx_i, int cy_i, int rad_i)
        {
            Point cp = make_point(cx_i, cy_i);

            Circle c;
            c.center = cp;
            c.rad = p_param_or_fail(rad_i);

            return c;
        }

        Ellipse make_ellipse(
            int cx_i, int cy_i, int focus1x_i, int focus1y_i, int radmin_i
        )
        {
            Ellipse e;
            e.center = make_point(cx_i, cy_i);
            e.focus1 = make_point(focus1x_i, focus1y_i);
            e.radmin = p_param_or_fail(radmin_i);

            return e;
        }

        Hyperbola make_hyperbola(
            int cx_i, int cy_i, int focus1x_i, int focus1y_i, int radmin_i
        )
        {
            Hyperbola h;
            h.center = make_point(cx_i, cy_i);
            h.focus1 = make_point(focus1x_i, focus1y_i);
            h.radmin = p_param_or_fail(radmin_i);

            return h;
        }

        Parabola make_parabola(
            int vertexx_i, int vertexy_i, int focus1x_i, int focus1y_i
        ) 
        {
            Parabola p;
            p.focus1 = make_point(focus1x_i, focus1y_i);
            p.vertex = make_point(vertexx_i, vertexy_i);

            return p;
        }

        Arc make_arc(
            int cx_i, int cy_i, int startx_i, int starty_i, int endx_i, int endy_i,
            int startangle_i, int endangle_i, int rad_i)
        {
            Point c = make_point(cx_i, cy_i);
            Point start = make_point(startx_i, starty_i);
            Point end = make_point(endx_i, endy_i);

            Arc a;
            a.center = c;
            a.start = start;
            a.startAngle = p_param_or_fail(startangle_i);
            a.endAngle = p_param_or_fail(endangle_i);
            a.end = end;
            a.rad = p_param_or_fail(rad_i);

            return a;
        }

        ArcOfEllipse make_arc_of_ellipse(
            int cx_i, int cy_i, int focus1x_i, int focus1y_i,
            int startx_i, int starty_i, int endx_i, int endy_i,
            int startangle_i, int endangle_i, int radmin_i
        )
        {
            ArcOfEllipse a;
            a.center = make_point(cx_i, cy_i);
            a.start = make_point(startx_i, starty_i);
            a.startAngle = p_param_or_fail(startangle_i);
            a.end = make_point(endx_i, endy_i); 
            a.endAngle = p_param_or_fail(endangle_i);
            a.radmin = p_param_or_fail(radmin_i);
            a.focus1 = make_point(focus1x_i, focus1y_i);

            return a;   
        }

        ArcOfParabola make_arc_of_parabola(
            int vertexx_i, int vertexy_i, int focusx_i, int focusy_i, int startx_i, int starty_i, int endx_i, int endy_i,
            int startangle_i, int endangle_i 
        )
        {
            ArcOfParabola a;
            a.start = make_point(startx_i, starty_i);
            a.startAngle = p_param_or_fail(startangle_i);
            a.end = make_point(endx_i, endy_i);
            a.endAngle = p_param_or_fail(endangle_i);
            a.focus1 = make_point(focusx_i, focusy_i);
            a.vertex = make_point(vertexx_i, vertexy_i);

            return a;
        }

        ArcOfHyperbola make_arc_of_hyperbola(
            int cx_i, int cy_i, int focus1x_i, int focus1y_i, int startx_i, int starty_i, int endx_i, int endy_i,
            int startangle_i, int endangle_i, int radmin_i
        )
        {
            ArcOfHyperbola a;
            a.center = make_point(cx_i, cy_i);
            a.start = make_point(startx_i, starty_i);
            a.startAngle = p_param_or_fail(startangle_i);
            a.end = make_point(endx_i, endy_i); 
            a.endAngle = p_param_or_fail(endangle_i);
            a.radmin = p_param_or_fail(radmin_i);
            a.focus1 = make_point(focus1x_i, focus1y_i);

            return a;   
        }
        
        BSpline make_bspline(
            int startx_i, int starty_i, int endx_i, int endy_i, vector<int> poles_xy_i,
            vector<int> weights_i, vector<int> knots_i, vector<int> mult, int degree, bool periodic
        )
        {
            BSpline bs;
            bs.start = make_point(startx_i, starty_i);
            bs.end = make_point(endx_i, endy_i);
            bs.degree = degree;
            bs.periodic = periodic;
            bs.mult = mult;

            for (int i = 0; i < poles_xy_i.size(); i += 2) {
                Point p = make_point(poles_xy_i[i], poles_xy_i[i + 1]);
                bs.poles.push_back(p);
            }

            for (int i = 0; i < weights_i.size(); i++) {
                bs.weights.push_back(p_param_or_fail(weights_i[i]));
            }

            for (int i = 0; i < knots_i.size(); i++) {
                bs.knots.push_back(p_param_or_fail(knots_i[i]));
            }
            
            return bs;
        }
        void add_constraint_equal(int  param1_param_i, int  param2_param_i, int tagId, bool driving, Constraint::Alignment internalalignment, double scale) {
            int i = addConstraintEqual(p_params[ param1_param_i], p_params[ param2_param_i], tagId, driving, internalalignment);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_proportional(int  param1_param_i, int  param2_param_i, double ratio, int tagId, bool driving, double scale) {
            int i = addConstraintProportional(p_params[ param1_param_i], p_params[ param2_param_i], ratio, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_difference(int  param1_param_i, int  param2_param_i, int  difference_param_i, int tagId, bool driving, double scale) {
            int i = addConstraintDifference(p_params[ param1_param_i], p_params[ param2_param_i], p_params[ difference_param_i], tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_p2p_distance(Point & p1, Point & p2, int  distance_param_i, int tagId, bool driving, double scale) {
            int i = addConstraintP2PDistance( p1,  p2, p_params[ distance_param_i], tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_p2p_angle_incr_angle(Point & p1, Point & p2, int  angle_param_i, double incrAngle, int tagId, bool driving, double scale) {
            int i = addConstraintP2PAngle( p1,  p2, p_params[ angle_param_i], incrAngle, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_p2p_angle(Point & p1, Point & p2, int  angle_param_i, int tagId, bool driving, double scale) {
            int i = addConstraintP2PAngle( p1,  p2, p_params[ angle_param_i], tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_p2l_distance(Point & p, Line & l, int  distance_param_i, int tagId, bool driving, double scale) {
            int i = addConstraintP2LDistance( p,  l, p_params[ distance_param_i], tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_point_on_line_pl(Point & p, Line & l, int tagId, bool driving, double scale) {
            int i = addConstraintPointOnLine( p,  l, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_point_on_line_ppp(Point & p, Point & lp1, Point & lp2, int tagId, bool driving, double scale) {
            int i = addConstraintPointOnLine( p,  lp1,  lp2, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_point_on_perp_bisector_pl(Point & p, Line & l, int tagId, bool driving, double scale) {
            int i = addConstraintPointOnPerpBisector( p,  l, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_point_on_perp_bisector_ppp(Point & p, Point & lp1, Point & lp2, int tagId, bool driving, double scale) {
            int i = addConstraintPointOnPerpBisector( p,  lp1,  lp2, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_parallel(Line & l1, Line & l2, int tagId, bool driving, double scale) {
            int i = addConstraintParallel( l1,  l2, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_perpendicular_ll(Line & l1, Line & l2, int tagId, bool driving, double scale) {
            int i = addConstraintPerpendicular( l1,  l2, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_perpendicular_pppp(Point & l1p1, Point & l1p2, Point & l2p1, Point & l2p2, int tagId, bool driving, double scale) {
            int i = addConstraintPerpendicular( l1p1,  l1p2,  l2p1,  l2p2, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_l2l_angle_ll(Line & l1, Line & l2, int  angle_param_i, int tagId, bool driving, double scale) {
            int i = addConstraintL2LAngle( l1,  l2, p_params[ angle_param_i], tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_l2l_angle_pppp(Point & l1p1, Point & l1p2, Point & l2p1, Point & l2p2, int  angle_param_i, int tagId, bool driving, double scale) {
            int i = addConstraintL2LAngle( l1p1,  l1p2,  l2p1,  l2p2, p_params[ angle_param_i], tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_angle_via_point(Curve & crv1, Curve & crv2, Point & p, int  angle_param_i, int tagId, bool driving, double scale) {
            int i = addConstraintAngleViaPoint( crv1,  crv2,  p, p_params[ angle_param_i], tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_angle_via_two_points(Curve & crv1, Curve & crv2, Point & p1, Point & p2, int  angle_param_i, int tagId, bool driving, double scale) {
            int i = addConstraintAngleViaTwoPoints( crv1,  crv2,  p1,  p2, p_params[ angle_param_i], tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_angle_via_point_and_param(Curve & crv1, Curve & crv2, Point & p, int  cparam_param_i, int  angle_param_i, int tagId, bool driving, double scale) {
            int i = addConstraintAngleViaPointAndParam( crv1,  crv2,  p, p_params[ cparam_param_i], p_params[ angle_param_i], tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_angle_via_point_and_two_params(Curve & crv1, Curve & crv2, Point & p, int  cparam1_param_i, int  cparam2_param_i, int  angle_param_i, int tagId, bool driving, double scale) {
            int i = addConstraintAngleViaPointAndTwoParams( crv1,  crv2,  p, p_params[ cparam1_param_i], p_params[ cparam2_param_i], p_params[ angle_param_i], tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_midpoint_on_line_ll(Line & l1, Line & l2, int tagId, bool driving, double scale) {
            int i = addConstraintMidpointOnLine( l1,  l2, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_midpoint_on_line_pppp(Point & l1p1, Point & l1p2, Point & l2p1, Point & l2p2, int tagId, bool driving, double scale) {
            int i = addConstraintMidpointOnLine( l1p1,  l1p2,  l2p1,  l2p2, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_tangent_circumf(Point & p1, Point & p2, int  rd1_param_i, int  rd2_param_i, bool internal, int tagId, bool driving, double scale) {
            int i = addConstraintTangentCircumf( p1,  p2, p_params[ rd1_param_i], p_params[ rd2_param_i], internal, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_tangent_at_bspline_knot(BSpline & b, Line & l, unsigned int knotindex, int tagId, bool driving, double scale) {
            int i = addConstraintTangentAtBSplineKnot( b,  l, knotindex, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_p2p_coincident(Point & p1, Point & p2, int tagId, bool driving, double scale) {
            int i = addConstraintP2PCoincident( p1,  p2, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_horizontal_l(Line & l, int tagId, bool driving, double scale) {
            int i = addConstraintHorizontal( l, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_horizontal_pp(Point & p1, Point & p2, int tagId, bool driving, double scale) {
            int i = addConstraintHorizontal( p1,  p2, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_vertical_l(Line & l, int tagId, bool driving, double scale) {
            int i = addConstraintVertical( l, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_vertical_pp(Point & p1, Point & p2, int tagId, bool driving, double scale) {
            int i = addConstraintVertical( p1,  p2, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_coordinate_x(Point & p, int  x_param_i, int tagId, bool driving, double scale) {
            int i = addConstraintCoordinateX( p, p_params[ x_param_i], tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_coordinate_y(Point & p, int  y_param_i, int tagId, bool driving, double scale) {
            int i = addConstraintCoordinateY( p, p_params[ y_param_i], tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_arc_rules(Arc & a, int tagId, bool driving, double scale) {
            int i = addConstraintArcRules( a, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_point_on_circle(Point & p, Circle & c, int tagId, bool driving, double scale) {
            int i = addConstraintPointOnCircle( p,  c, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_point_on_ellipse(Point & p, Ellipse & e, int tagId, bool driving, double scale) {
            int i = addConstraintPointOnEllipse( p,  e, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_point_on_hyperbolic_arc(Point & p, ArcOfHyperbola & e, int tagId, bool driving, double scale) {
            int i = addConstraintPointOnHyperbolicArc( p,  e, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_point_on_parabolic_arc(Point & p, ArcOfParabola & e, int tagId, bool driving, double scale) {
            int i = addConstraintPointOnParabolicArc( p,  e, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_point_on_bspline(Point & p, BSpline & b, int  pointparam_param_i, int tagId, bool driving, double scale) {
            int i = addConstraintPointOnBSpline( p,  b, p_params[ pointparam_param_i], tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_arc_of_ellipse_rules(ArcOfEllipse & a, int tagId, bool driving, double scale) {
            int i = addConstraintArcOfEllipseRules( a, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_curve_value(Point & p, Curve & a, int  u_param_i, int tagId, bool driving, double scale) {
            int i = addConstraintCurveValue( p,  a, p_params[ u_param_i], tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_arc_of_hyperbola_rules(ArcOfHyperbola & a, int tagId, bool driving, double scale) {
            int i = addConstraintArcOfHyperbolaRules( a, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_arc_of_parabola_rules(ArcOfParabola & a, int tagId, bool driving, double scale) {
            int i = addConstraintArcOfParabolaRules( a, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_point_on_arc(Point & p, Arc & a, int tagId, bool driving, double scale) {
            int i = addConstraintPointOnArc( p,  a, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_perpendicular_line2arc(Point & p1, Point & p2, Arc & a, int tagId, bool driving, double scale) {
            int i = addConstraintPerpendicularLine2Arc( p1,  p2,  a, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_perpendicular_arc2line(Arc & a, Point & p1, Point & p2, int tagId, bool driving, double scale) {
            int i = addConstraintPerpendicularArc2Line( a,  p1,  p2, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_perpendicular_circle2arc(Point & center, int  radius_param_i, Arc & a, int tagId, bool driving, double scale) {
            int i = addConstraintPerpendicularCircle2Arc( center, p_params[ radius_param_i],  a, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_perpendicular_arc2circle(Arc & a, Point & center, int  radius_param_i, int tagId, bool driving, double scale) {
            int i = addConstraintPerpendicularArc2Circle( a,  center, p_params[ radius_param_i], tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_perpendicular_arc2arc(Arc & a1, bool reverse1, Arc & a2, bool reverse2, int tagId, bool driving, double scale) {
            int i = addConstraintPerpendicularArc2Arc( a1, reverse1,  a2, reverse2, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_tangent_lc(Line & l, Circle & c, int tagId, bool driving, double scale) {
            int i = addConstraintTangent( l,  c, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_tangent_le(Line & l, Ellipse & e, int tagId, bool driving, double scale) {
            int i = addConstraintTangent( l,  e, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_tangent_la(Line & l, Arc & a, int tagId, bool driving, double scale) {
            int i = addConstraintTangent( l,  a, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_tangent_cc(Circle & c1, Circle & c2, int tagId, bool driving, double scale) {
            int i = addConstraintTangent( c1,  c2, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_tangent_aa(Arc & a1, Arc & a2, int tagId, bool driving, double scale) {
            int i = addConstraintTangent( a1,  a2, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_tangent_ca(Circle & c, Arc & a, int tagId, bool driving, double scale) {
            int i = addConstraintTangent( c,  a, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_circle_radius(Circle & c, int  radius_param_i, int tagId, bool driving, double scale) {
            int i = addConstraintCircleRadius( c, p_params[ radius_param_i], tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_arc_radius(Arc & a, int  radius_param_i, int tagId, bool driving, double scale) {
            int i = addConstraintArcRadius( a, p_params[ radius_param_i], tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_circle_diameter(Circle & c, int  diameter_param_i, int tagId, bool driving, double scale) {
            int i = addConstraintCircleDiameter( c, p_params[ diameter_param_i], tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_arc_diameter(Arc & a, int  diameter_param_i, int tagId, bool driving, double scale) {
            int i = addConstraintArcDiameter( a, p_params[ diameter_param_i], tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_equal_length(Line & l1, Line & l2, int tagId, bool driving, double scale) {
            int i = addConstraintEqualLength( l1,  l2, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_equal_radius_cc(Circle & c1, Circle & c2, int tagId, bool driving, double scale) {
            int i = addConstraintEqualRadius( c1,  c2, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_equal_radii_ee(Ellipse & e1, Ellipse & e2, int tagId, bool driving, double scale) {
            int i = addConstraintEqualRadii( e1,  e2, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_equal_radii_ahah(ArcOfHyperbola & a1, ArcOfHyperbola & a2, int tagId, bool driving, double scale) {
            int i = addConstraintEqualRadii( a1,  a2, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_equal_radius_ca(Circle & c1, Arc & a2, int tagId, bool driving, double scale) {
            int i = addConstraintEqualRadius( c1,  a2, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_equal_radius_aa(Arc & a1, Arc & a2, int tagId, bool driving, double scale) {
            int i = addConstraintEqualRadius( a1,  a2, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_equal_focus(ArcOfParabola & a1, ArcOfParabola & a2, int tagId, bool driving, double scale) {
            int i = addConstraintEqualFocus( a1,  a2, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_p2p_symmetric_ppl(Point & p1, Point & p2, Line & l, int tagId, bool driving, double scale) {
            int i = addConstraintP2PSymmetric( p1,  p2,  l, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_p2p_symmetric_ppp(Point & p1, Point & p2, Point & p, int tagId, bool driving, double scale) {
            int i = addConstraintP2PSymmetric( p1,  p2,  p, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_snells_law(Curve & ray1, Curve & ray2, Curve & boundary, Point p, int  n1_param_i, int  n2_param_i, bool flipn1, bool flipn2, int tagId, bool driving, double scale) {
            int i = addConstraintSnellsLaw( ray1,  ray2,  boundary, p, p_params[ n1_param_i], p_params[ n2_param_i], flipn1, flipn2, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_c2cdistance(Circle & c1, Circle & c2, int  dist_param_i, int tagId, bool driving, double scale) {
            int i = addConstraintC2CDistance( c1,  c2, p_params[ dist_param_i], tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_c2ldistance(Circle & c, Line & l, int  dist_param_i, int tagId, bool driving, double scale) {
            int i = addConstraintC2LDistance( c,  l, p_params[ dist_param_i], tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_p2cdistance(Point & p, Circle & c, int  distance_param_i, int tagId, bool driving, double scale) {
            int i = addConstraintP2CDistance( p,  c, p_params[ distance_param_i], tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_arc_length(Arc & a, int  dist_param_i, int tagId, bool driving, double scale) {
            int i = addConstraintArcLength( a, p_params[ dist_param_i], tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_internal_alignment_point2ellipse(Ellipse & e, Point & p1, InternalAlignmentType alignmentType, int tagId, bool driving, double scale) {
            int i = addConstraintInternalAlignmentPoint2Ellipse( e,  p1, alignmentType, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_internal_alignment_ellipse_major_diameter(Ellipse & e, Point & p1, Point & p2, int tagId, bool driving, double scale) {
            int i = addConstraintInternalAlignmentEllipseMajorDiameter( e,  p1,  p2, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_internal_alignment_ellipse_minor_diameter(Ellipse & e, Point & p1, Point & p2, int tagId, bool driving, double scale) {
            int i = addConstraintInternalAlignmentEllipseMinorDiameter( e,  p1,  p2, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_internal_alignment_ellipse_focus1(Ellipse & e, Point & p1, int tagId, bool driving, double scale) {
            int i = addConstraintInternalAlignmentEllipseFocus1( e,  p1, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_internal_alignment_ellipse_focus2(Ellipse & e, Point & p1, int tagId, bool driving, double scale) {
            int i = addConstraintInternalAlignmentEllipseFocus2( e,  p1, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_internal_alignment_point2hyperbola(Hyperbola & e, Point & p1, InternalAlignmentType alignmentType, int tagId, bool driving, double scale) {
            int i = addConstraintInternalAlignmentPoint2Hyperbola( e,  p1, alignmentType, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_internal_alignment_hyperbola_major_diameter(Hyperbola & e, Point & p1, Point & p2, int tagId, bool driving, double scale) {
            int i = addConstraintInternalAlignmentHyperbolaMajorDiameter( e,  p1,  p2, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_internal_alignment_hyperbola_minor_diameter(Hyperbola & e, Point & p1, Point & p2, int tagId, bool driving, double scale) {
            int i = addConstraintInternalAlignmentHyperbolaMinorDiameter( e,  p1,  p2, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_internal_alignment_hyperbola_focus(Hyperbola & e, Point & p1, int tagId, bool driving, double scale) {
            int i = addConstraintInternalAlignmentHyperbolaFocus( e,  p1, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_internal_alignment_parabola_focus(Parabola & e, Point & p1, int tagId, bool driving, double scale) {
            int i = addConstraintInternalAlignmentParabolaFocus( e,  p1, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_internal_alignment_bspline_control_point(BSpline & b, Circle & c, unsigned int poleindex, int tag, bool driving, double scale) {
            int i = addConstraintInternalAlignmentBSplineControlPoint( b,  c, poleindex, tag, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }

        void add_constraint_internal_alignment_knot_point(BSpline & b, Point & p, unsigned int knotindex, int tagId, bool driving, double scale) {
            int i = addConstraintInternalAlignmentKnotPoint( b,  p, knotindex, tagId, driving);
            if (scale != 1) {
                rescaleConstraint(i, scale);
            }
        }


    private:
        double* p_param_or_fail(int i) {
            if (p_params.size() <= i) {
                throw std::runtime_error("parameter index outside range");
            }
            return p_params[i];
        }
};

#include <emscripten/bind.h>  

EMSCRIPTEN_BINDINGS(module) {
    emscripten::register_vector<double>("DoubleVector");
    emscripten::register_vector<int>("IntVector");
    emscripten::enum_<InternalAlignmentType>("InternalAlignmentType")
        .value("EllipsePositiveMajorX", EllipsePositiveMajorX)
        .value("EllipsePositiveMajorY", EllipsePositiveMajorY)
        .value("EllipseNegativeMajorX", EllipseNegativeMajorX)
        .value("EllipseNegativeMajorY", EllipseNegativeMajorY)
        .value("EllipsePositiveMinorX", EllipsePositiveMinorX)
        .value("EllipsePositiveMinorY", EllipsePositiveMinorY)
        .value("EllipseNegativeMinorX", EllipseNegativeMinorX)
        .value("EllipseNegativeMinorY", EllipseNegativeMinorY)
        .value("EllipseFocus2X", EllipseFocus2X)
        .value("EllipseFocus2Y", EllipseFocus2Y)
        .value("HyperbolaPositiveMajorX", HyperbolaPositiveMajorX)
        .value("HyperbolaPositiveMajorY", HyperbolaPositiveMajorY)
        .value("HyperbolaNegativeMajorX", HyperbolaNegativeMajorX)
        .value("HyperbolaNegativeMajorY", HyperbolaNegativeMajorY)
        .value("HyperbolaPositiveMinorX", HyperbolaPositiveMinorX)
        .value("HyperbolaPositiveMinorY", HyperbolaPositiveMinorY)
        .value("HyperbolaNegativeMinorX", HyperbolaNegativeMinorX)
        .value("HyperbolaNegativeMinorY", HyperbolaNegativeMinorY);

    emscripten::enum_<DebugMode>("DebugMode")
        .value("NoDebug", NoDebug)
        .value("Minimal", Minimal)
        .value("IterationLevel", IterationLevel);

    emscripten::enum_<Constraint::Alignment>("Constraint::Alignment")
        .value("NoInternalAlignment", Constraint::Alignment::NoInternalAlignment)
        .value("InternalAlignment", Constraint::Alignment::InternalAlignment);

    emscripten::enum_<SolveStatus>("SolveStatus")
        .value("Success", Success)
        .value("Converged", Converged)
        .value("Failed", Failed)
        .value("SuccessfulSolutionInvalid", SuccessfulSolutionInvalid);

    emscripten::enum_<Algorithm>("Algorithm")
        .value("BFGS", BFGS)
        .value("LevenbergMarquardt", LevenbergMarquardt)
        .value("DogLeg", DogLeg);

    emscripten::class_<Point>("Point");
    emscripten::class_<Curve>("Curve");
    emscripten::class_<Line, emscripten::base<Curve>>("Line");
    emscripten::class_<Circle, emscripten::base<Curve>>("Circle");
    emscripten::class_<Ellipse, emscripten::base<Curve>>("Ellipse");
    emscripten::class_<Hyperbola, emscripten::base<Curve>>("Hyperbola");
    emscripten::class_<Parabola, emscripten::base<Curve>>("Parabola");
    emscripten::class_<Arc, emscripten::base<Circle>>("Arc");
    emscripten::class_<ArcOfHyperbola, emscripten::base<Hyperbola>>("ArcOfHyperbola");
    emscripten::class_<ArcOfEllipse, emscripten::base<Ellipse>>("ArcOfEllipse");
    emscripten::class_<ArcOfParabola, emscripten::base<Parabola>>("ArcOfParabola");
    emscripten::class_<BSpline, emscripten::base<Curve>>("BSpline");

    emscripten::class_<GcsSystem>("GcsSystem")
        .constructor<>()
        .function("params_size", &GcsSystem::params_size)
        .function("get_p_param", &GcsSystem::get_p_param)
        .function("get_p_params", &GcsSystem::get_p_params)
        .function("set_p_param", &GcsSystem::set_p_param)
        .function("push_p_param", &GcsSystem::push_p_param)
        .function("get_is_fixed", &GcsSystem::get_is_fixed)
        .function("solve_system", &GcsSystem::solve_system)
        .function("clear_data", &GcsSystem::clear_data)
        /* functions adapted from GCS::System */
        .function("apply_solution", &GcsSystem::apply_solution)
        .function("dof", &GcsSystem::dof)
        .function("get_conflicting", &GcsSystem::get_conflicting)
        .function("get_redundant", &GcsSystem::get_redundant)
        .function("get_partially_redundant", &GcsSystem::get_partially_redundant)
        .function("has_conflicting", &GcsSystem::has_conflicting)
        .function("has_redundant", &GcsSystem::has_redundant)
        .function("has_partially_redundant", &GcsSystem::has_partially_redundant)
        .function("clear_by_id", &GcsSystem::clear_by_id)
        .function("init_solution", &GcsSystem::init_solution)
        .function("solve_prepared", &GcsSystem::solve_prepared)
        .function("diagnose_fresh", &GcsSystem::diagnose_fresh)
        .function("add_constraint_point_on_affine_spline", &GcsSystem::add_constraint_point_on_affine_spline)
        .function("get_dependent_params", &GcsSystem::get_dependent_params)
        .function("get_dependent_param_groups", &GcsSystem::get_dependent_param_groups)
        .function("params_to_buffer", &GcsSystem::params_to_buffer)
        .function("input_buffer", &GcsSystem::input_buffer)
        .function("params_from_buffer", &GcsSystem::params_from_buffer)
        .function("set_dl_gauss_step", &GcsSystem::set_dl_gauss_step)
        .function("get_dl_gauss_step", &GcsSystem::get_dl_gauss_step)
        .function("set_sparse_sqp_min_params", &GcsSystem::set_sparse_sqp_min_params)
        .function("set_max_iterations", &GcsSystem::set_max_iterations)
        .function("get_max_iterations", &GcsSystem::get_max_iterations)
        .function("set_covergence_threshold", &GcsSystem::set_covergence_threshold)
        .function("get_convergence_threshold", &GcsSystem::get_convergence_threshold)
        .function("set_debug_mode", &GcsSystem::set_debug_mode)
        .function("get_debug_mode", &GcsSystem::get_debug_mode)
        /* make_<geometry> functions */
        .function("make_point", &GcsSystem::make_point)
        .function("make_line", &GcsSystem::make_line)
        .function("make_circle", &GcsSystem::make_circle)
        .function("make_ellipse", &GcsSystem::make_ellipse)
        .function("make_hyperbola", &GcsSystem::make_hyperbola)
        .function("make_parabola", &GcsSystem::make_parabola)
        .function("make_arc", &GcsSystem::make_arc)
        .function("make_arc_of_hyperbola", &GcsSystem::make_arc_of_hyperbola)
        .function("make_arc_of_ellipse", &GcsSystem::make_arc_of_ellipse)
        .function("make_arc_of_parabola", &GcsSystem::make_arc_of_parabola)
        .function("make_bspline", &GcsSystem::make_bspline)
        /* constraint functions */
        .function("add_constraint_equal", &GcsSystem::add_constraint_equal)
        .function("add_constraint_proportional", &GcsSystem::add_constraint_proportional)
        .function("add_constraint_difference", &GcsSystem::add_constraint_difference)
        .function("add_constraint_p2p_distance", &GcsSystem::add_constraint_p2p_distance)
        .function("add_constraint_p2p_angle_incr_angle", &GcsSystem::add_constraint_p2p_angle_incr_angle)
        .function("add_constraint_p2p_angle", &GcsSystem::add_constraint_p2p_angle)
        .function("add_constraint_p2l_distance", &GcsSystem::add_constraint_p2l_distance)
        .function("add_constraint_point_on_line_pl", &GcsSystem::add_constraint_point_on_line_pl)
        .function("add_constraint_point_on_line_ppp", &GcsSystem::add_constraint_point_on_line_ppp)
        .function("add_constraint_point_on_perp_bisector_pl", &GcsSystem::add_constraint_point_on_perp_bisector_pl)
        .function("add_constraint_point_on_perp_bisector_ppp", &GcsSystem::add_constraint_point_on_perp_bisector_ppp)
        .function("add_constraint_parallel", &GcsSystem::add_constraint_parallel)
        .function("add_constraint_perpendicular_ll", &GcsSystem::add_constraint_perpendicular_ll)
        .function("add_constraint_perpendicular_pppp", &GcsSystem::add_constraint_perpendicular_pppp)
        .function("add_constraint_l2l_angle_ll", &GcsSystem::add_constraint_l2l_angle_ll)
        .function("add_constraint_l2l_angle_pppp", &GcsSystem::add_constraint_l2l_angle_pppp)
        .function("add_constraint_angle_via_point", &GcsSystem::add_constraint_angle_via_point)
        .function("add_constraint_angle_via_two_points", &GcsSystem::add_constraint_angle_via_two_points)
        .function("add_constraint_angle_via_point_and_param", &GcsSystem::add_constraint_angle_via_point_and_param)
        .function("add_constraint_angle_via_point_and_two_params", &GcsSystem::add_constraint_angle_via_point_and_two_params)
        .function("add_constraint_midpoint_on_line_ll", &GcsSystem::add_constraint_midpoint_on_line_ll)
        .function("add_constraint_midpoint_on_line_pppp", &GcsSystem::add_constraint_midpoint_on_line_pppp)
        .function("add_constraint_tangent_circumf", &GcsSystem::add_constraint_tangent_circumf)
        .function("add_constraint_tangent_at_bspline_knot", &GcsSystem::add_constraint_tangent_at_bspline_knot)
        .function("add_constraint_p2p_coincident", &GcsSystem::add_constraint_p2p_coincident)
        .function("add_constraint_horizontal_l", &GcsSystem::add_constraint_horizontal_l)
        .function("add_constraint_horizontal_pp", &GcsSystem::add_constraint_horizontal_pp)
        .function("add_constraint_vertical_l", &GcsSystem::add_constraint_vertical_l)
        .function("add_constraint_vertical_pp", &GcsSystem::add_constraint_vertical_pp)
        .function("add_constraint_coordinate_x", &GcsSystem::add_constraint_coordinate_x)
        .function("add_constraint_coordinate_y", &GcsSystem::add_constraint_coordinate_y)
        .function("add_constraint_arc_rules", &GcsSystem::add_constraint_arc_rules)
        .function("add_constraint_point_on_circle", &GcsSystem::add_constraint_point_on_circle)
        .function("add_constraint_point_on_ellipse", &GcsSystem::add_constraint_point_on_ellipse)
        .function("add_constraint_point_on_hyperbolic_arc", &GcsSystem::add_constraint_point_on_hyperbolic_arc)
        .function("add_constraint_point_on_parabolic_arc", &GcsSystem::add_constraint_point_on_parabolic_arc)
        .function("add_constraint_point_on_bspline", &GcsSystem::add_constraint_point_on_bspline)
        .function("add_constraint_arc_of_ellipse_rules", &GcsSystem::add_constraint_arc_of_ellipse_rules)
        .function("add_constraint_curve_value", &GcsSystem::add_constraint_curve_value)
        .function("add_constraint_arc_of_hyperbola_rules", &GcsSystem::add_constraint_arc_of_hyperbola_rules)
        .function("add_constraint_arc_of_parabola_rules", &GcsSystem::add_constraint_arc_of_parabola_rules)
        .function("add_constraint_point_on_arc", &GcsSystem::add_constraint_point_on_arc)
        .function("add_constraint_perpendicular_line2arc", &GcsSystem::add_constraint_perpendicular_line2arc)
        .function("add_constraint_perpendicular_arc2line", &GcsSystem::add_constraint_perpendicular_arc2line)
        .function("add_constraint_perpendicular_circle2arc", &GcsSystem::add_constraint_perpendicular_circle2arc)
        .function("add_constraint_perpendicular_arc2circle", &GcsSystem::add_constraint_perpendicular_arc2circle)
        .function("add_constraint_perpendicular_arc2arc", &GcsSystem::add_constraint_perpendicular_arc2arc)
        .function("add_constraint_tangent_lc", &GcsSystem::add_constraint_tangent_lc)
        .function("add_constraint_tangent_le", &GcsSystem::add_constraint_tangent_le)
        .function("add_constraint_tangent_la", &GcsSystem::add_constraint_tangent_la)
        .function("add_constraint_tangent_cc", &GcsSystem::add_constraint_tangent_cc)
        .function("add_constraint_tangent_aa", &GcsSystem::add_constraint_tangent_aa)
        .function("add_constraint_tangent_ca", &GcsSystem::add_constraint_tangent_ca)
        .function("add_constraint_circle_radius", &GcsSystem::add_constraint_circle_radius)
        .function("add_constraint_arc_radius", &GcsSystem::add_constraint_arc_radius)
        .function("add_constraint_circle_diameter", &GcsSystem::add_constraint_circle_diameter)
        .function("add_constraint_arc_diameter", &GcsSystem::add_constraint_arc_diameter)
        .function("add_constraint_equal_length", &GcsSystem::add_constraint_equal_length)
        .function("add_constraint_equal_radius_cc", &GcsSystem::add_constraint_equal_radius_cc)
        .function("add_constraint_equal_radii_ee", &GcsSystem::add_constraint_equal_radii_ee)
        .function("add_constraint_equal_radii_ahah", &GcsSystem::add_constraint_equal_radii_ahah)
        .function("add_constraint_equal_radius_ca", &GcsSystem::add_constraint_equal_radius_ca)
        .function("add_constraint_equal_radius_aa", &GcsSystem::add_constraint_equal_radius_aa)
        .function("add_constraint_equal_focus", &GcsSystem::add_constraint_equal_focus)
        .function("add_constraint_p2p_symmetric_ppl", &GcsSystem::add_constraint_p2p_symmetric_ppl)
        .function("add_constraint_p2p_symmetric_ppp", &GcsSystem::add_constraint_p2p_symmetric_ppp)
        .function("add_constraint_snells_law", &GcsSystem::add_constraint_snells_law)
        .function("add_constraint_c2cdistance", &GcsSystem::add_constraint_c2cdistance)
        .function("add_constraint_c2ldistance", &GcsSystem::add_constraint_c2ldistance)
        .function("add_constraint_p2cdistance", &GcsSystem::add_constraint_p2cdistance)
        .function("add_constraint_arc_length", &GcsSystem::add_constraint_arc_length)
        .function("add_constraint_internal_alignment_point2ellipse", &GcsSystem::add_constraint_internal_alignment_point2ellipse)
        .function("add_constraint_internal_alignment_ellipse_major_diameter", &GcsSystem::add_constraint_internal_alignment_ellipse_major_diameter)
        .function("add_constraint_internal_alignment_ellipse_minor_diameter", &GcsSystem::add_constraint_internal_alignment_ellipse_minor_diameter)
        .function("add_constraint_internal_alignment_ellipse_focus1", &GcsSystem::add_constraint_internal_alignment_ellipse_focus1)
        .function("add_constraint_internal_alignment_ellipse_focus2", &GcsSystem::add_constraint_internal_alignment_ellipse_focus2)
        .function("add_constraint_internal_alignment_point2hyperbola", &GcsSystem::add_constraint_internal_alignment_point2hyperbola)
        .function("add_constraint_internal_alignment_hyperbola_major_diameter", &GcsSystem::add_constraint_internal_alignment_hyperbola_major_diameter)
        .function("add_constraint_internal_alignment_hyperbola_minor_diameter", &GcsSystem::add_constraint_internal_alignment_hyperbola_minor_diameter)
        .function("add_constraint_internal_alignment_hyperbola_focus", &GcsSystem::add_constraint_internal_alignment_hyperbola_focus)
        .function("add_constraint_internal_alignment_parabola_focus", &GcsSystem::add_constraint_internal_alignment_parabola_focus)
        .function("add_constraint_internal_alignment_bspline_control_point", &GcsSystem::add_constraint_internal_alignment_bspline_control_point)
        .function("add_constraint_internal_alignment_knot_point", &GcsSystem::add_constraint_internal_alignment_knot_point)
        ;
}