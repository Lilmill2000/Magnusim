//-----------------------------------------------------------------------------
// Created on: 04 September 2025
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

#ifndef asiAlgo_BlendTopoConditionFFIsolatedShell_h
#define asiAlgo_BlendTopoConditionFFIsolatedShell_h

// asiAlgo includes
#include <asiAlgo_BlendTopoConditionFF.h>
#include <asiAlgo_Utils.h>

//! \ingroup ASI_AFR
//!
//! Topological condition for isolated face-face blends on shells.
struct asiAlgo_BlendTopoConditionFFIsolatedShell : public asiAlgo_BlendTopoConditionFF
{
  // OCCT RTTI
  DEFINE_STANDARD_RTTI_INLINE(asiAlgo_BlendTopoConditionFFIsolatedShell, asiAlgo_BlendTopoConditionFF)

public:

  TopoDS_Edge   e_b_t1;    //!< Terminating edge 1 for the blend face `b`.
  TopoDS_Edge   e_b_t2;    //!< Terminating edge 2 for the blend face `b`.
  TopoDS_Edge   e_s1_t1;   //!< Edge between `s1` and `t1` virtual side.
  TopoDS_Edge   e_s1_t2;   //!< Edge between `s1` and `t2` virtual side.
  TopoDS_Edge   e_s2_t1;   //!< Edge between `s2` and `t1` virtual side.
  TopoDS_Edge   e_s2_t2;   //!< Edge between `s2` and `t2` virtual side.
  TopoDS_Vertex v_b_s1_t1; //!< Vertex common for `b`, `s1` and `t1`.
  TopoDS_Vertex v_b_s2_t1; //!< Vertex common for `b`, `s2` and `t1`.
  TopoDS_Vertex v_b_s1_t2; //!< Vertex common for `b`, `s1` and `t2`.
  TopoDS_Vertex v_b_s2_t2; //!< Vertex common for `b`, `s2` and `t2`.

public:

  //! Ctor.
  //! \param[in] aag      attributed adjacency graph of the CAD-model in question.
  //! \param[in] progress progress notifier.
  //! \param[in] plotter  imperative plotter.
  asiAlgo_BlendTopoConditionFFIsolatedShell(const Handle(asiAlgo_AAG)& aag,
                                            ActAPI_ProgressEntry       progress,
                                            ActAPI_PlotterEntry        plotter)
  //
  : asiAlgo_BlendTopoConditionFF(aag, progress, plotter)
  {}

public:

  //! Dumps the topological condition to the passed plotter.
  virtual void Dump(ActAPI_PlotterEntry plotter) const
  {
    asiAlgo_BlendTopoConditionFF::Dump(plotter); // Dump base entities.

    plotter.REDRAW_SHAPE("e_b_t1",    this->e_b_t1,    Color_Red,   1.0, true);
    plotter.REDRAW_SHAPE("e_b_t2",    this->e_b_t2,    Color_Red,   1.0, true);
    plotter.REDRAW_SHAPE("e_s1_t1",   this->e_s1_t1,   Color_White, 1.0, true);
    plotter.REDRAW_SHAPE("e_s1_t2",   this->e_s1_t2,   Color_White, 1.0, true);
    plotter.REDRAW_SHAPE("e_s2_t1",   this->e_s2_t1,   Color_White, 1.0, true);
    plotter.REDRAW_SHAPE("e_s2_t2",   this->e_s2_t2,   Color_White, 1.0, true);
    plotter.REDRAW_SHAPE("v_b_s1_t1", this->v_b_s1_t1, Color_White, 1.0, true);
    plotter.REDRAW_SHAPE("v_b_s1_t2", this->v_b_s1_t2, Color_White, 1.0, true);
    plotter.REDRAW_SHAPE("v_b_s2_t1", this->v_b_s2_t1, Color_White, 1.0, true);
    plotter.REDRAW_SHAPE("v_b_s2_t2", this->v_b_s2_t2, Color_White, 1.0, true);
  }

  //! Allows to identify a certain topological condition from the passed blend
  //! candidate attribute.
  //! \param[in] bcAttr blend candidate attribute in question.
  //! \return true if the certain topological condition is identified. If not,
  //!         this method returns false and the recognizer will try another
  //!         condition.
  virtual bool Initialize(const Handle(asiAlgo_AttrBlendCandidate)& bcAttr)
  {
    // Identify the spring edges and the support faces.
    if ( !asiAlgo_BlendTopoConditionFF::Initialize(bcAttr) )
      return false; // Not identified.

    // Isolated blend contains two terminating edges.
    const int numCrossEdges  = bcAttr->CrossEdgeIndices.Extent();
    const int numTermEdges   = bcAttr->TerminatingEdgeIndices.Extent();
    const int numSpringEdges = bcAttr->SpringEdgeIndices.Extent();
    //
    if ( numCrossEdges != 0 || numTermEdges != 2 || numSpringEdges != 2 )
      return false;

    // Get ID of the blend face.
    const int f_b_idx = bcAttr->GetFaceId();

    // There should be no other cylinders in the vicinity of this blend face.
    asiAlgo_Feature vnids = AAG->GetNeighborsThruVerts(f_b_idx);
    //
    for ( asiAlgo_Feature::Iterator nit(vnids); nit.More(); nit.Next() )
    {
      const int nid = nit.Key();
      //
      if ( asiAlgo_Utils::IsCylindrical( AAG->GetFace(nid) ) )
        return false;
    }

    // Get terminating edges.
    const int   e_b_t1_idx = bcAttr->TerminatingEdgeIndices.GetMinimalMapped();
    const int   e_b_t2_idx = bcAttr->TerminatingEdgeIndices.GetMaximalMapped();
    TopoDS_Edge e_b_t1_loc = TopoDS::Edge( AAG->RequestMapOfEdges()(e_b_t1_idx) );
    TopoDS_Edge e_b_t2_loc = TopoDS::Edge( AAG->RequestMapOfEdges()(e_b_t2_idx) );

    // Get terminating (`t`) faces as neighbors to the blend face through
    // the terminating edges: for the shell condition, we expect to have
    // no terminating faces.
    TColStd_PackedMapOfInteger f_b_t1_indices = AAG->GetNeighborsThru(f_b_idx, e_b_t1_loc);
    TColStd_PackedMapOfInteger f_b_t2_indices = AAG->GetNeighborsThru(f_b_idx, e_b_t2_loc);
    //
    if ( f_b_t1_indices.Extent() != 0 || f_b_t2_indices.Extent() != 0 )
      return false;

    // Initialize topological primitives.
    this->e_b_t1 = e_b_t1_loc;
    this->e_b_t2 = e_b_t2_loc;

    // Get common vertices.
    this->v_b_s1_t1 = asiAlgo_Utils::GetCommonVertex(this->e_b_t1, this->e_b_s1);
    this->v_b_s2_t1 = asiAlgo_Utils::GetCommonVertex(this->e_b_t1, this->e_b_s2);
    this->v_b_s1_t2 = asiAlgo_Utils::GetCommonVertex(this->e_b_t2, this->e_b_s1);
    this->v_b_s2_t2 = asiAlgo_Utils::GetCommonVertex(this->e_b_t2, this->e_b_s2);
    //
    if ( this->v_b_s1_t1.IsNull() ||
         this->v_b_s2_t1.IsNull() ||
         this->v_b_s1_t2.IsNull() ||
         this->v_b_s2_t2.IsNull() )
    {
      return false;
    }

    // Get other common edges.
    const TopTools_IndexedDataMapOfShapeListOfShape& EF = this->AAG->RequestMapOfEdgesFaces();
    //
    this->e_s1_t1 = asiAlgo_Utils::GetFreeEdge(EF, this->v_b_s1_t1, this->e_b_t1);
    this->e_s1_t2 = asiAlgo_Utils::GetFreeEdge(EF, this->v_b_s1_t2, this->e_b_t2);
    this->e_s2_t1 = asiAlgo_Utils::GetFreeEdge(EF, this->v_b_s2_t1, this->e_b_t1);
    this->e_s2_t2 = asiAlgo_Utils::GetFreeEdge(EF, this->v_b_s2_t2, this->e_b_t2);

    // Check that we have only 3 edges at each feature vertex.
    const TopTools_IndexedDataMapOfShapeListOfShape& VE = this->AAG->RequestMapOfVerticesEdges();
    TopTools_ListOfShape VE_lists[4] =
    {
      VE.FindFromKey(this->v_b_s1_t1),
      VE.FindFromKey(this->v_b_s2_t1),
      VE.FindFromKey(this->v_b_s1_t2),
      VE.FindFromKey(this->v_b_s2_t2)
    };
    //
    for ( int k = 0; k < 4; ++k )
    {
      if ( VE_lists[k].Extent() > 3 )
      {
        if ( !m_plotter.Access().IsNull() )
        {
          for ( TopTools_ListIteratorOfListOfShape lit(VE_lists[k]); lit.More(); lit.Next() )
          {
            m_plotter.DRAW_SHAPE( lit.Value(), Color_Blue, 1., true, "VE_edge" );
          }
        }

        return false;
      }
    }

    // Check if all edges are initialized.
    if ( this->e_s1_t1.IsNull() ||
         this->e_s1_t2.IsNull() ||
         this->e_s2_t1.IsNull() ||
         this->e_s2_t2.IsNull() )
    {
      return false;
    }

    // This condition works nicely for straight terminating edges only.
    // E.g., see cases like `kill-blend_095.tcl`. Straight edges can be
    // extended easily while more "curved" geometries might require adding
    // extra edges to suppress the feature of interest.
    if ( !asiAlgo_Utils::IsStraight(this->e_s1_t1) ||
         !asiAlgo_Utils::IsStraight(this->e_s1_t2) ||
         !asiAlgo_Utils::IsStraight(this->e_s2_t1) ||
         !asiAlgo_Utils::IsStraight(this->e_s2_t2) )
    {
      return false;
    }

    this->Dump(m_plotter);

    return true; // Identified.
  }

  //! Collapses topology locally.
  //! \param[in]  input   input shape to perform feature suppression on.
  //! \param[out] output  suppression result.
  //! \param[out] history modification history.
  //! \return true in case of success, false -- otherwise.
  virtual bool Suppress(const TopoDS_Shape&      input,
                        TopoDS_Shape&            output,
                        Handle(asiAlgo_History)& history)
  {
    output = input;

    if ( history.IsNull() )
      history = new asiAlgo_History;

    // Kill the first terminating edge. We also specify a vertex to kill to
    // be as much deterministic as possible.
    if ( !this->kev(output, this->e_b_t1, this->v_b_s1_t1, output, history) )
    {
      m_progress.SendLogMessage(LogErr(Normal) << "KEV failed on terminating edge.");
      return false;
    }
    //
    this->Actualize(history);

    // Kill the second terminating edge.
    if ( !this->kev(output, this->e_b_t2, this->v_b_s1_t2, output, history) )
    {
      m_progress.SendLogMessage(LogErr(Normal) << "KEV failed on terminating edge.");
      return false;
    }
    //
    this->Actualize(history);

    // Kill the blend face.
    if ( !this->kef(output, this->f_b, this->e_b_s2, this->e_b_s1, output, history) )
    {
      m_progress.SendLogMessage(LogErr(Normal) << "KEF failed for the blend face and spring edge.");
      return false;
    }
    //
    this->Actualize(history);

    return true;
  }

  //! Actualizes the current state of topological condition w.r.t. the
  //! passed history.
  //! \param[in] history modification history to apply.
  virtual void Actualize(const Handle(asiAlgo_History)& history)
  {
    this->f_b       = TopoDS::Face   ( history->GetLastImageOrArg(this->f_b) );
    this->f_s1      = TopoDS::Face   ( history->GetLastImageOrArg(this->f_s1) );
    this->f_s2      = TopoDS::Face   ( history->GetLastImageOrArg(this->f_s2) );
    this->e_b_t1    = TopoDS::Edge   ( history->GetLastImageOrArg(this->e_b_t1) );
    this->e_b_t2    = TopoDS::Edge   ( history->GetLastImageOrArg(this->e_b_t2) );
    this->e_b_s1    = TopoDS::Edge   ( history->GetLastImageOrArg(this->e_b_s1) );
    this->e_b_s2    = TopoDS::Edge   ( history->GetLastImageOrArg(this->e_b_s2) );
    this->e_s1_t1   = TopoDS::Edge   ( history->GetLastImageOrArg(this->e_s1_t1) );
    this->e_s1_t2   = TopoDS::Edge   ( history->GetLastImageOrArg(this->e_s1_t2) );
    this->e_s2_t1   = TopoDS::Edge   ( history->GetLastImageOrArg(this->e_s2_t1) );
    this->e_s2_t2   = TopoDS::Edge   ( history->GetLastImageOrArg(this->e_s2_t2) );
    this->v_b_s1_t1 = TopoDS::Vertex ( history->GetLastImageOrArg(this->v_b_s1_t1) );
    this->v_b_s1_t2 = TopoDS::Vertex ( history->GetLastImageOrArg(this->v_b_s1_t2) );
    this->v_b_s2_t1 = TopoDS::Vertex ( history->GetLastImageOrArg(this->v_b_s2_t1) );
    this->v_b_s2_t2 = TopoDS::Vertex ( history->GetLastImageOrArg(this->v_b_s2_t2) );
  }

  //! Gathers the collection of affected edges to rebuild as a result of
  //! suppression. Every edge may declare some vertices as "frozen", i.e.,
  //! these vertices need no recomputation at geometry normalization stage.
  //! The decision whether to freeze or not a specific vertex will be taken
  //! by the computational scheme as it possesses knowledge not only of
  //! one topological condition, but of many of them. That is to say that
  //! if one vertex is frozen in one topological condition, it may be
  //! non-frozen in another. In such situation, for the normalization stage
  //! to succeed, such vertices should be unfreezed.
  //!
  //! \param[out] edges output collection of edges to rebuild.
  virtual void GatherAffectedEdges(asiAlgo_Edges2Rebuild& edges) const
  {
    edges.Add( asiAlgo_Edge2Rebuild(this->e_s1_t1, this->v_b_s2_t1, false) );
    edges.Add( asiAlgo_Edge2Rebuild(this->e_s1_t2, this->v_b_s2_t2, false) );
    edges.Add( asiAlgo_Edge2Rebuild(this->e_b_s1) );
    edges.Add( asiAlgo_Edge2Rebuild(this->e_s2_t1, this->v_b_s2_t1, false) );
    edges.Add( asiAlgo_Edge2Rebuild(this->e_s2_t2, this->v_b_s2_t2, false) );
  }

};

#endif
