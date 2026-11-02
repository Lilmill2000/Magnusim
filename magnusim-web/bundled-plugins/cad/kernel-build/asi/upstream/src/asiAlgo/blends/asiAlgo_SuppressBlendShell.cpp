//-----------------------------------------------------------------------------
// Created on: 11 September 2025
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
#include "asiAlgo_SuppressBlendShell.h"

// asiAlgo includes
#include "asiAlgo_AttrBlendCandidate.h"
#include "asiAlgo_CheckValidity.h"
#include "asiAlgo_RecognizeEBF.h"
#include "asiAlgo_TopoKill.h"

// OpenCascade includes
#include <BRep_Builder.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepOffsetAPI_ThruSections.hxx>
#include <ShapeAnalysis_Curve.hxx>
#include <TopoDS_Shell.hxx>

//-----------------------------------------------------------------------------

asiAlgo_SuppressBlendShell::asiAlgo_SuppressBlendShell(const TopoDS_Shape&  shape,
                                                       ActAPI_ProgressEntry progress,
                                                       ActAPI_PlotterEntry  plotter)
//
: ActAPI_IAlgorithm ( progress, plotter ),
  m_input           ( shape ),
  m_aag             ( new asiAlgo_AAG(shape) )
{}

//-----------------------------------------------------------------------------

asiAlgo_SuppressBlendShell::asiAlgo_SuppressBlendShell(const Handle(asiAlgo_AAG)& aag,
                                                       ActAPI_ProgressEntry       progress,
                                                       ActAPI_PlotterEntry        plotter)
//
: ActAPI_IAlgorithm ( progress, plotter ),
  m_input           ( aag->GetMasterShape() ),
  m_aag             ( aag )
{}

//-----------------------------------------------------------------------------

bool asiAlgo_SuppressBlendShell::Perform(const int fid)
{
  /* ===================
   *  Preparation stage.
   * =================== */

  const TopoDS_Face& blendFace = m_aag->GetFace(fid);

  /* =========================
   *  Recognize bend as blend.
   * ========================= */

  // Access the blend attribute (if any).
  Handle(asiAlgo_AttrBlendCandidate)
    bcAttr = m_aag->ATTR_NODE<asiAlgo_AttrBlendCandidate>(fid);

  if ( bcAttr.IsNull() )
  {
    // Feature recognize the target face right in place.
    asiAlgo_RecognizeEBF recognizeEbf(m_aag, m_progress, m_plotter);
    //
    if ( !recognizeEbf.Perform( fid, Precision::Infinite() ) )
      return false;
  }

  // Access the recognition result.
  bcAttr = m_aag->ATTR_NODE<asiAlgo_AttrBlendCandidate>(fid);
  //
  if ( bcAttr.IsNull() )
  {
    m_progress.SendLogMessage( LogErr(Normal) << "Face %1 is not a bend feature."
                                              << fid );
    return false;
  }

  if ( bcAttr->SpringEdgeIndices.Extent() != 2 )
  {
    m_progress.SendLogMessage( LogErr(Normal) << "Unexpected number of spring edges "
                                                 "(2 expected, %1 extracted)."
                                              << bcAttr->SpringEdgeIndices.Extent() );
    //
    return false;
  }

  const int e1 = bcAttr->SpringEdgeIndices.GetMinimalMapped();
  const int e2 = bcAttr->SpringEdgeIndices.GetMaximalMapped();

  TopoDS_Edge E1 = TopoDS::Edge( m_aag->RequestMapOfEdges().FindKey(e1) );
  TopoDS_Edge E2 = TopoDS::Edge( m_aag->RequestMapOfEdges().FindKey(e2) );

  // Get support faces.
  asiAlgo_Feature nids = m_aag->GetNeighbors(fid);
  //
  if ( nids.Extent() != 2 )
  {
    m_progress.SendLogMessage( LogErr(Normal) << "Unexpected number of support faces "
                                                 "(2 expected, %1 extracted)."
                                              << nids.Extent() );
    //
    return false;
  }

  const int f_s1 = nids.GetMinimalMapped();
  const int f_s2 = nids.GetMaximalMapped();

  const TopoDS_Face& F_s1 = m_aag->GetFace(f_s1);
  const TopoDS_Face& F_s2 = m_aag->GetFace(f_s2);

  /* ==================================
   *  Compute supplementary geometries.
   * ================================== */

  Handle(asiAlgo_IntersectionCurveSS) iCurve;
  //
  if ( !asiAlgo_Utils::IntersectSurfaces(F_s1, F_s2, iCurve) )
  {
    m_progress.SendLogMessage(LogErr(Normal) << "Failed to intersect support faces %1 and %2."
                                             << f_s1 << f_s2);
    //
    return false;
  }

  m_plotter.REDRAW_CURVE("iCurve", iCurve->C, Color_Green, true);

  TopoDS_Face extFace[2];
  //
  if ( !this->buildExtensionFace(E1, iCurve, extFace[0]) )
  {
    return false;
  }
  //
  if ( !this->buildExtensionFace(E2, iCurve, extFace[1]) )
  {
    return false;
  }

  /* ============
   *  Kill blend.
   * ============ */

  // Prepare killer.
  asiAlgo_TopoKill killer(m_input);
  //
  if ( !killer.AskRemove(blendFace) )
  {
    m_progress.SendLogMessage(LogErr(Normal) << "Request on removal rejected.");
    //
    return false;
  }

  if ( !killer.Apply() )
  {
    m_progress.SendLogMessage(LogErr(Normal) << "Topological killer failed.");
    //
    return false;
  }

  // Get result.
  m_result = killer.GetResult();

  // Initialize history.
  m_history = killer.GetHistory();

  /* =========================
   *  Compose the final shell.
   * ========================= */

  TopTools_IndexedMapOfShape Fs;
  TopExp::MapShapes(m_result, TopAbs_FACE, Fs);

  TopoDS_Shell shell;
  BRep_Builder bbuilder;

  bbuilder.MakeShell(shell);
  //
  for ( int f = 1; f <= Fs.Extent(); ++f )
  {
    bbuilder.Add( shell, Fs(f) );
  }
  //
  bbuilder.Add( shell, extFace[0] );
  bbuilder.Add( shell, extFace[1] );
  //
  m_history->AddRoot(extFace[0]);
  m_history->AddRoot(extFace[1]);

  // Stitch faces.
  Handle(asiAlgo_History) H;
  if ( !asiAlgo_Utils::SewMaximize( shell,
                                    asiAlgo_CheckValidity().MaxTolerance(m_input),
                                    m_result,
                                    H,
                                    m_progress,
                                    m_plotter ) )
  {
    return false;
  }

  return true; // Success.
}

//-----------------------------------------------------------------------------

bool asiAlgo_SuppressBlendShell::buildExtensionFace(const TopoDS_Edge&                         edge,
                                                    const Handle(asiAlgo_IntersectionCurveSS)& iCurve,
                                                    TopoDS_Face&                               F) const
{
  // Find the extremity vertices on the passed edge.
  TopoDS_Vertex Vf, Vl;
  TopExp::Vertices(edge, Vf, Vl);

  // Project extremities to the intersection curve.
  gp_Pnt Pf, Pl;
  double tf, tl;
  ShapeAnalysis_Curve sac;
  //
  sac.Project(iCurve->C,
              BRep_Tool::Pnt(Vf),
              Precision::Confusion(),
              Pf,
              tf);
  //
  sac.Project(iCurve->C,
              BRep_Tool::Pnt(Vl),
              Precision::Confusion(),
              Pl,
              tl);

  // Build another edge on the intersection curve
  // trimmed by the projected vertices.
  TopoDS_Edge target = BRepBuilderAPI_MakeEdge(iCurve->C, Pf, Pl, tf, tl);

  m_plotter.DRAW_SHAPE(target, Color_Red, 1., true, "target");

  // Initialize loft tool.
  BRepOffsetAPI_ThruSections ThruSections( false, // shell mode
                                           true, // ruled surface
                                           Precision::Confusion() );
  ThruSections.SetSmoothing(false);
  ThruSections.SetMaxDegree(1);
  //
  ThruSections.AddWire( BRepBuilderAPI_MakeWire(edge) );
  ThruSections.AddWire( BRepBuilderAPI_MakeWire(target) );
  //
  ThruSections.Build();
  //
  if ( !ThruSections.IsDone() )
  {
    m_progress.SendLogMessage(LogErr(Normal) << "Skinning failed.");
    //
    return false;
  }

  TopTools_IndexedMapOfShape Fs;
  TopExp::MapShapes(ThruSections.Shape(), TopAbs_FACE, Fs);
  //
  F = TopoDS::Face( Fs(1) );

  m_plotter.DRAW_SHAPE(F, Color_White, "extensionFace");

  return true;
}
