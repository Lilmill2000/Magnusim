//-----------------------------------------------------------------------------
// Created on: 05 September 2025
//-----------------------------------------------------------------------------
// Copyright (c) 2025-present, Sergey Slyadnev
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
//    * Redistributions of source code must retain the above copyright
//      notice, this list of conditions and the following disclaimer.
//    * Redistributions in binary form must reproduce the above copyright
//      notice, this list of conditions and the following disclaimer in the
//      documentation and/or other materials provided with the distribution.
//    * Neither the name of the copyright holder(s) nor the
//      names of all contributors may be used to endorse or promote products
//      derived from this software without specific prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
// ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
// WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
// DISCLAIMED. IN NO EVENT SHALL THE AUTHORS OR CONTRIBUTORS BE LIABLE FOR ANY
// DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
// (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
// LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
// ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
// SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
//-----------------------------------------------------------------------------

// Own include
#include <asiAlgo_ModConstructEdgeShell.h>

// asiAlgo includes
#include <asiAlgo_IntersectCS.h>

// OCCT includes
#include <BRep_Tool.hxx>
#include <GC_MakeSegment.hxx>
#include <Geom_Line.hxx>
#include <Geom_TrimmedCurve.hxx>
#include <GeomConvert.hxx>
#include <Precision.hxx>
#include <ShapeAnalysis_Curve.hxx>
#include <ShapeAnalysis_Edge.hxx>
#include <ShapeAnalysis_Surface.hxx>
#include <ShapeBuild_Edge.hxx>
#include <ShapeConstruct_ProjectCurveOnSurface.hxx>
#include <ShapeFix_Edge.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Vertex.hxx>

#undef COUT_DEBUG
#if defined COUT_DEBUG
  #pragma message("===== warning: COUT_DEBUG is enabled")
#endif

#undef DRAW_DEBUG
#if defined DRAW_DEBUG
  #pragma message("===== warning: DRAW_DEBUG is enabled")
#endif

//-----------------------------------------------------------------------------

asiAlgo_ModConstructEdgeShell::asiAlgo_ModConstructEdgeShell(const TopoDS_Shape&  shape,
                                                             ActAPI_ProgressEntry notifier,
                                                             ActAPI_PlotterEntry  plotter)
: asiAlgo_ModBase(notifier, plotter)
{
  m_shape = shape;
}

//-----------------------------------------------------------------------------

bool asiAlgo_ModConstructEdgeShell::Init(const Handle(asiAlgo_BlendTopoConditionFFIsolatedShell)& situ)
{
  // Initialize topological situation.
  return this->initSituation(situ);
}

//-----------------------------------------------------------------------------

void asiAlgo_ModConstructEdgeShell::SetFrozenVertices(const TopTools_IndexedMapOfShape& vertices)
{
  m_frozenVertices = vertices;
}

//-----------------------------------------------------------------------------

void asiAlgo_ModConstructEdgeShell::Dump(ActAPI_PlotterEntry plotter) const
{
  m_edgeInfo.DumpSituation(plotter);
}

//-----------------------------------------------------------------------------

bool asiAlgo_ModConstructEdgeShell::NewSurface(const TopoDS_Face&    asiAlgo_NotUsed(F),
                                               Handle(Geom_Surface)& asiAlgo_NotUsed(S),
                                               TopLoc_Location&      asiAlgo_NotUsed(L),
                                               double&               asiAlgo_NotUsed(tol),
                                               bool&                 asiAlgo_NotUsed(revWires),
                                               bool&                 asiAlgo_NotUsed(revFace))
{
  // Surfaces are not changed.
  return false;
}

//-----------------------------------------------------------------------------

bool asiAlgo_ModConstructEdgeShell::NewCurve(const TopoDS_Edge&  E,
                                             Handle(Geom_Curve)& C,
                                             TopLoc_Location&    L,
                                             double&             tol)
{
  TopoDS_Vertex Vf = TopExp::FirstVertex(E);
  TopoDS_Vertex Vl = TopExp::LastVertex(E);

  if ( E.IsPartner(m_edgeInfo.situation.e_s1_s2) )
  {
    // Check and set the result.
    if ( !m_edgeInfo.resolution.icurve.IsNull() )
    {
      // Set updated data for the caller
      C   = m_edgeInfo.resolution.icurve->C;
      L   = TopLoc_Location();
      tol = Max( BRep_Tool::Tolerance(E), m_edgeInfo.resolution.icurve->Uncertainty );
      //
      return true;
    }
  }

  else if ( E.IsPartner(m_edgeInfo.situation.e_s1_t1) ||
            E.IsPartner(m_edgeInfo.situation.e_s2_t1) )
  {
    if ( Vf.IsPartner(m_edgeInfo.situation.v_s1_s2_t1) )
    {
      Handle(Geom_TrimmedCurve)
        line = GC_MakeSegment( m_edgeInfo.resolution.ivf.point, BRep_Tool::Pnt(Vl) );
      //
      C = line;

      m_plotter.DRAW_CURVE(C, Color_Green, false, "case1");
    }
    else if ( Vl.IsPartner(m_edgeInfo.situation.v_s1_s2_t1) )
    {
      Handle(Geom_TrimmedCurve)
        line = GC_MakeSegment( BRep_Tool::Pnt(Vf), m_edgeInfo.resolution.ivf.point );
      //
      C = line;

      m_plotter.DRAW_CURVE(C, Color_Green, false, "case2");
    }

    asiAlgo_ModEdgeInfo::Resolution::t_edgeStatus es(C, true);
    //
    //es.extremities;

    m_edgeInfo.resolution.edgeFan.Bind( E, es );

    L   = TopLoc_Location();
    tol = BRep_Tool::Tolerance(E);
    return true;
  }

  else if ( E.IsPartner(m_edgeInfo.situation.e_s1_t2) ||
            E.IsPartner(m_edgeInfo.situation.e_s2_t2) )
  {
    if ( Vf.IsPartner(m_edgeInfo.situation.v_s1_s2_t2) )
    {
      if ( m_edgeInfo.resolution.ivl.point.Distance( BRep_Tool::Pnt(Vl) ) < Precision::Confusion() )
      {
        m_progress.SendLogMessage(LogErr(Normal) << "Cannot build a line segment.");

        this->SetErrorStateOn();
        return false;
      }

      Handle(Geom_TrimmedCurve)
        line = GC_MakeSegment( m_edgeInfo.resolution.ivl.point, BRep_Tool::Pnt(Vl) );
      //
      C = line;

      m_plotter.DRAW_CURVE(C, Color_Green, false, "case3");
    }
    else if ( Vl.IsPartner(m_edgeInfo.situation.v_s1_s2_t2) )
    {
      if ( m_edgeInfo.resolution.ivl.point.Distance( BRep_Tool::Pnt(Vf) ) < Precision::Confusion() )
      {
        m_progress.SendLogMessage(LogErr(Normal) << "Cannot build a line segment.");

        this->SetErrorStateOn();
        return false;
      }

      Handle(Geom_TrimmedCurve)
        line = GC_MakeSegment( BRep_Tool::Pnt(Vf), m_edgeInfo.resolution.ivl.point );
      //
      C = line;

      m_plotter.DRAW_CURVE(C, Color_Green, false, "case4");
    }

    m_edgeInfo.resolution.edgeFan.Bind( E, asiAlgo_ModEdgeInfo::Resolution::t_edgeStatus(C, true) );

    L   = TopLoc_Location();
    tol = BRep_Tool::Tolerance(E);
    return true;
  }

  return false;
}

//-----------------------------------------------------------------------------

bool asiAlgo_ModConstructEdgeShell::NewPoint(const TopoDS_Vertex& V,
                                             gp_Pnt&              P,
                                             double&              tol)
{
  if ( !V.IsPartner(m_edgeInfo.situation.v_s1_s2_t1) &&
       !V.IsPartner(m_edgeInfo.situation.v_s1_s2_t2) )
    return false;

  // Get old point of the vertex.
  gp_Pnt oldPt = BRep_Tool::Pnt(V);

  // Do not evaluate "frozen" vertices. This small `if` is a part of
  // our knowledge-driven computation paradigm. According to the latter,
  // if you know that a vertex is already in its "good" position, then
  // do not try to reevaluate it. Such a paradigm is especially fruitful
  // in cases where intersection is not well-defined, e.g., when tangential
  // situation is realized.
  if ( m_frozenVertices.Contains(V) )
  {
    m_progress.SendLogMessage(LogNotice(Normal) << "Skipping 'frozen' vertex.");
    m_plotter.DRAW_SHAPE(V, Color_Blue, 1.0, true, "frozen_vertex");

    // Use existing geometry.
    P   = oldPt;
    tol = BRep_Tool::Tolerance(V);

    // Set resolution.
    if ( V.IsPartner(m_edgeInfo.situation.v_s1_s2_t1) )
      m_edgeInfo.resolution.ivf.Init(P, 0., true);
    else
      m_edgeInfo.resolution.ivl.Init(P, 0., true);

    return this->checkResolvedVertices(); // Check if the vertices are Ok.
  }

  // Intersection point.
  asiAlgo_ModEdgeInfo::Resolution::t_vertexStatus* ipoint = nullptr;

  // Curve and surface to intersect.
  Handle(Geom_Curve) icurve = m_edgeInfo.resolution.icurve->C;

  // Reproject the old point to the intersection curve.
  double p = 0;
  gp_Pnt proj;
  ShapeAnalysis_Curve sac;
  sac.Project(m_edgeInfo.resolution.icurve->C,
              oldPt,
              Precision::Confusion(),
              proj,
              p);

  // First vertex.
  if ( V.IsPartner(m_edgeInfo.situation.v_s1_s2_t1) )
  {
    ipoint = &m_edgeInfo.resolution.ivf;
  }
  else if ( V.IsPartner(m_edgeInfo.situation.v_s1_s2_t2) ) // Last vertex.
  {
    ipoint = &m_edgeInfo.resolution.ivl;
  }

  // Initialize intersection point.
  ipoint->Init(proj, 0., true);

//#if defined DRAW_DEBUG
  if ( V.IsPartner(m_edgeInfo.situation.v_s1_s2_t1) )
    m_plotter.DRAW_POINT((*ipoint).point, Color_Red, "NewPoint:P (v first)");
  else
    m_plotter.DRAW_POINT((*ipoint).point, Color_Blue, "NewPoint:P (v last)");
//#endif

  // Set updated data for the caller.
  P   = ipoint->point;
  tol = Precision::Confusion();
  //
  return this->checkResolvedVertices(); // Check if the vertices are Ok.
}

//-----------------------------------------------------------------------------

bool asiAlgo_ModConstructEdgeShell::NewCurve2d(const TopoDS_Edge&    E,
                                               const TopoDS_Face&    asiAlgo_NotUsed(F),
                                               const TopoDS_Edge&    NewE,
                                               const TopoDS_Face&    NewF,
                                               Handle(Geom2d_Curve)& C,
                                               double&               tol)
{
  Handle(Geom2d_Curve) c2d;

  if ( E.IsPartner(m_edgeInfo.situation.e_s1_s2) ||
       E.IsPartner(m_edgeInfo.situation.e_s1_t1) ||
       E.IsPartner(m_edgeInfo.situation.e_s1_t2) ||
       E.IsPartner(m_edgeInfo.situation.e_s2_t1) ||
       E.IsPartner(m_edgeInfo.situation.e_s2_t2) )
  {
    try
    {
      c2d = this->buildPCurve(NewE, NewF);
    }
    catch ( ... )
    {
      m_progress.SendLogMessage(LogErr(Normal) << "Crash on constructing p-curve.");
    }

    if ( c2d.IsNull() )
    {
      m_progress.SendLogMessage(LogErr(Normal) << "Cannot fix p-curve.");

      this->SetErrorStateOn();
      return false;
    }

    C   = c2d;
    tol = BRep_Tool::Tolerance(E);

//#if defined DRAW_DEBUG
    m_plotter.DRAW_CURVE2D(C, Color_Blue, "NewCurve2d:c2d");
//#endif

    return true;
  }

  return false;
}

//-----------------------------------------------------------------------------

bool asiAlgo_ModConstructEdgeShell::NewParameter(const TopoDS_Vertex& V,
                                                 const TopoDS_Edge&   E,
                                                 double&              p,
                                                 double&              tol)
{
  //if ( !V.IsPartner(m_edgeInfo.situation.v_s1_s2_t1) &&
  //     !V.IsPartner(m_edgeInfo.situation.v_s1_s2_t2) )
  //  return false;

  if ( E.IsPartner(m_edgeInfo.situation.e_s1_s2) )
  {
    // V_first
    if ( V.IsPartner(m_edgeInfo.situation.v_s1_s2_t1) )
    {
      gp_Pnt proj;
      ShapeAnalysis_Curve sac;
      sac.Project(m_edgeInfo.resolution.icurve->C,
                  m_edgeInfo.resolution.ivf.point,
                  Precision::Confusion(),
                  proj,
                  p);

      // Adjust period.
      if ( asiAlgo_Utils::IsBasisCircular(m_edgeInfo.resolution.icurve->C) )
        if ( p - M_PI > 0 )
          p = p - 2*M_PI;

      m_progress.SendLogMessage(LogInfo(Normal) << "P in NewParameter for v_first on target edge: %1." << p);
      m_plotter.DRAW_POINT(proj, Color_Yellow, "P in NewParameter for v_first on target edge");
    }

    // V_last
    else if ( V.IsPartner(m_edgeInfo.situation.v_s1_s2_t2) )
    {
      gp_Pnt proj;
      ShapeAnalysis_Curve sac;
      sac.Project(m_edgeInfo.resolution.icurve->C,
                  m_edgeInfo.resolution.ivl.point,
                  Precision::Confusion(),
                  proj,
                  p);

      // Adjust period.
      if ( asiAlgo_Utils::IsBasisCircular(m_edgeInfo.resolution.icurve->C) )
        if ( p - M_PI > 0 )
          p = p - 2*M_PI;

      m_progress.SendLogMessage(LogInfo(Normal) << "P in NewParameter for v_last on target edge: %1." << p);
      m_plotter.DRAW_POINT(proj, Color_Yellow, "P in NewParameter for v_last on target edge");
    }

    tol = BRep_Tool::Tolerance(V);
    return true;
  }
  else
  {
    const asiAlgo_ModEdgeInfo::Resolution::t_edgeStatus*
      pStatus = m_edgeInfo.resolution.edgeFan.Seek(E);
    //
    if ( !pStatus || !pStatus->done )
      return false;

    Handle(Geom_Curve) C = pStatus->curve;

    gp_Pnt P;
    //
    if ( V.IsPartner(m_edgeInfo.situation.v_s1_s2_t1) ||
         V.IsPartner(m_edgeInfo.situation.v_s1_s2_t2) )
    {
      P = V.IsPartner(m_edgeInfo.situation.v_s1_s2_t1) ? m_edgeInfo.resolution.ivf.point
                                                       : m_edgeInfo.resolution.ivl.point;
    }
    else
    {
      P = BRep_Tool::Pnt(V);
    }
     

    gp_Pnt proj;
    ShapeAnalysis_Curve sac;
    sac.Project(C,
                P,
                Precision::Confusion(),
                proj,
                p);

    m_progress.SendLogMessage(LogInfo(Normal) << "P in NewParameter for v_first on target edge: %1." << p);
    m_plotter.DRAW_POINT(P, Color_Red, "PPP");
    m_plotter.DRAW_POINT(proj, Color_Yellow, "P in NewParameter for v_first on target edge");

    tol = BRep_Tool::Tolerance(V);
    return true;
  }
}

//-----------------------------------------------------------------------------

GeomAbs_Shape
  asiAlgo_ModConstructEdgeShell::Continuity(const TopoDS_Edge& E,
                                            const TopoDS_Face& F1,
                                            const TopoDS_Face& F2,
                                            const TopoDS_Edge& asiAlgo_NotUsed(NewE),
                                            const TopoDS_Face& asiAlgo_NotUsed(NewF1),
                                            const TopoDS_Face& asiAlgo_NotUsed(NewF2))
{
  return BRep_Tool::Continuity(E, F1, F2);
}

//-----------------------------------------------------------------------------

bool asiAlgo_ModConstructEdgeShell::initSituation(const Handle(asiAlgo_BlendTopoConditionFFIsolatedShell)& situ)
{
  /* ==================================
   *  Initialize topological situation.
   * ================================== */

  m_edgeInfo.situation.e_s1_t1 = situ->e_s1_t1;
  m_edgeInfo.situation.e_s1_t2 = situ->e_s1_t2;
  m_edgeInfo.situation.e_s1_s2 = situ->e_b_s1; // == `e_b_s1` because of KEF
  m_edgeInfo.situation.e_s2_t1 = situ->e_s2_t1;
  m_edgeInfo.situation.e_s2_t2 = situ->e_s2_t2;

  m_edgeInfo.situation.f_s1 = situ->f_s1;
  m_edgeInfo.situation.f_s2 = situ->f_s2;

  m_edgeInfo.situation.v_s1_s2_t1 = situ->v_b_s1_t1; // == `v_b_s2_t1` because of KEV
  m_edgeInfo.situation.v_s1_s2_t2 = situ->v_b_s1_t2; // == `v_b_s2_t2` because of KEV

#if defined DRAW_DEBUG
  m_edgeInfo.DumpSituation(m_plotter);
#endif

  /* ============================================
   *  Re-intersect faces (just once for an edge).
   * ============================================ */

  // Re-intersect base faces.
  if ( !asiAlgo_Utils::IntersectSurfaces(m_edgeInfo.situation.f_s1,
                                         m_edgeInfo.situation.f_s2,
                                         m_edgeInfo.resolution.icurve) )
  {
    m_progress.SendLogMessage(LogErr(Normal) << "Cannot intersect faces.");

    this->SetErrorStateOn();
    return false;
  }

  // Correct orientation. BRepTools_Modifier framework does not handle
  // changing orientation of curves, so if after re-intersection the
  // geometric orientation is affected, we have to fix it here.
  if ( !this->correctOriC(m_edgeInfo.resolution.icurve->C,
                          m_edgeInfo.situation.e_s1_s2,
                          m_edgeInfo.resolution.icurve->C) )
  {
    m_progress.SendLogMessage(LogErr(Normal) << "Cannot correct orientation of the intersection curve.");

    this->SetErrorStateOn();
    return false;
  }

//#if defined DRAW_DEBUG
  m_plotter.REDRAW_CURVE("Resolution.icurve", m_edgeInfo.resolution.icurve->C, Color_Green);
//#endif

  return true;
}

//-----------------------------------------------------------------------------

Handle(Geom2d_Curve)
  asiAlgo_ModConstructEdgeShell::buildPCurve(const TopoDS_Edge& E,
                                             const TopoDS_Face& F)
{
  static int count = 0;
  count++;

  Handle(ShapeConstruct_ProjectCurveOnSurface)
    projector = new ShapeConstruct_ProjectCurveOnSurface;

  double f, l;
  Handle(Geom_Curve) c3d = BRep_Tool::Curve(E, f, l);

//#if defined DRAW_DEBUG
  m_plotter.DRAW_CURVE(new Geom_TrimmedCurve(c3d, f, l), Color_Red, true, "buildPCurve:E(curve)");
  m_plotter.DRAW_SURFACE(BRep_Tool::Surface(F), Color_White, "buildPCurve:F");
//#endif

  Handle(Geom2d_Curve) c2d;
  double TolFirst = -1, TolLast = -1;
  TopoDS_Vertex V1, V2;
  TopExp::Vertices(E, V1, V2);
  if (!V1.IsNull())
    TolFirst = BRep_Tool::Tolerance(V1);
  if (!V2.IsNull())
    TolLast = BRep_Tool::Tolerance(V2);
      
  Handle(ShapeAnalysis_Surface)
    sas = new ShapeAnalysis_Surface( BRep_Tool::Surface(F) );

  try
  {
    projector->Init ( sas, Precision::Confusion() );
    projector->Perform (c3d,f,l,c2d,TolFirst,TolLast);
  }
  catch ( ... )
  {
    this->SetErrorStateOn();
  }

  return c2d;
}

//-----------------------------------------------------------------------------

bool asiAlgo_ModConstructEdgeShell::checkResolvedVertices()
{
  if ( !m_edgeInfo.resolution.ivf.done || !m_edgeInfo.resolution.ivl.done )
    return true; // Check is done only if both vertices are resolved.

  // Check if the vertices are not coincident.
  if ( m_edgeInfo.resolution.ivf.point.Distance(m_edgeInfo.resolution.ivl.point) < Precision::Confusion() )
  {
    this->SetErrorStateOn();
    return false;
  }

  return true;
}
