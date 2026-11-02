//-----------------------------------------------------------------------------
// Created on: 15 September 2025
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

#ifndef asiAlgo_BlendTopoConditionFFIsolatedShellComplex_h
#define asiAlgo_BlendTopoConditionFFIsolatedShellComplex_h

// asiAlgo includes
#include <asiAlgo_BlendTopoConditionFF.h>
#include <asiAlgo_Utils.h>

//! \ingroup ASI_AFR
//!
//! Topological condition for isolated face-face blends on shells with complex topology.
//! This can be a situation at a corner where several blends touch each other. Also, this
//! can be the situation we multiple terminating edges.
struct asiAlgo_BlendTopoConditionFFIsolatedShellComplex : public asiAlgo_BlendTopoConditionFF
{
  // OCCT RTTI
  DEFINE_STANDARD_RTTI_INLINE(asiAlgo_BlendTopoConditionFFIsolatedShellComplex, asiAlgo_BlendTopoConditionFF)

public:

  //! Ctor.
  //! \param[in] aag      attributed adjacency graph of the CAD-model in question.
  //! \param[in] progress progress notifier.
  //! \param[in] plotter  imperative plotter.
  asiAlgo_BlendTopoConditionFFIsolatedShellComplex(const Handle(asiAlgo_AAG)& aag,
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

    const int numCrossEdges  = bcAttr->CrossEdgeIndices.Extent();
    const int numTermEdges   = bcAttr->TerminatingEdgeIndices.Extent();
    const int numSpringEdges = bcAttr->SpringEdgeIndices.Extent();
    //
    if ( numCrossEdges != 0 || numTermEdges == 0 || numSpringEdges != 2 )
      return false;

    // Get ID of the blend face.
    const int f_b_idx = bcAttr->GetFaceId();

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
    return false;
  }

  //! Actualizes the current state of topological condition w.r.t. the
  //! passed history.
  //! \param[in] history modification history to apply.
  virtual void Actualize(const Handle(asiAlgo_History)& history)
  {
    this->f_b       = TopoDS::Face   ( history->GetLastImageOrArg(this->f_b) );
    this->f_s1      = TopoDS::Face   ( history->GetLastImageOrArg(this->f_s1) );
    this->f_s2      = TopoDS::Face   ( history->GetLastImageOrArg(this->f_s2) );
    this->e_b_s1    = TopoDS::Edge   ( history->GetLastImageOrArg(this->e_b_s1) );
    this->e_b_s2    = TopoDS::Edge   ( history->GetLastImageOrArg(this->e_b_s2) );
  }

  //! Gathers the collection of affected edges to rebuild as a result of
  //! suppression.
  //!
  //! \param[out] edges output collection of edges to rebuild.
  virtual void GatherAffectedEdges(asiAlgo_Edges2Rebuild& edges) const
  {
    edges.Add( asiAlgo_Edge2Rebuild(this->e_b_s1) );
  }

};

#endif
