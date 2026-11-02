//-----------------------------------------------------------------------------
// Created on: 01 October 2018
//-----------------------------------------------------------------------------
// Copyright (c) 2018-present, Sergey Slyadnev
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
#include <asiAlgo_RecognizeBlends.h>

// STL includes
#include <algorithm>

// asiAlgo includes
#include <asiAlgo_AAGIterator.h>
#include <asiAlgo_AttrBlendCandidate.h>
#include <asiAlgo_ExtractFeatures.h>
#include <asiAlgo_FeatureType.h>
#include <asiAlgo_RecognizeEBF.h>
#include <asiAlgo_RecognizeVBF.h>

#undef COUT_DEBUG
#if defined COUT_DEBUG
  #pragma message("===== warning: COUT_DEBUG is enabled")
#endif

//-----------------------------------------------------------------------------

namespace
{
  //! Rounds the passed double value. E.g., to round a value to 3 points
  //! decimal, use the following trick:
  //!
  //! value = ::RoundDouble(value*1000.)/1000.
  //!
  //! \param[in] val the value to round.
  //! \return the rounded value.
  double RoundDouble(const double val)
  {
    if ( val < 0 ) return ceil(val - 0.5);
    return floor(val + 0.5);
  }

  //! Computes the total length of a blend chain passed as a feature.
  //! \param[in] feature the blend chain in question.
  //! \param[in] aag     the AAG instance.
  //! \return the computed total length.
  double BlendChainLength(const asiAlgo_Feature&     feature,
                          const Handle(asiAlgo_AAG)& aag)
  {
    double len = 0.;
    for ( asiAlgo_Feature::Iterator fit(feature); fit.More(); fit.Next() )
    {
      const int fid = fit.Key();

      Handle(asiAlgo_AttrBlendCandidate)
        bcAttr = aag->ATTR_NODE<asiAlgo_AttrBlendCandidate>(fid);
      //
      if ( bcAttr.IsNull() )
        return false;

      len += bcAttr->Length;
    }
    return len;
  }
}

//-----------------------------------------------------------------------------

//! \brief Function to filter the extracted blend candidates by radius.
class asiAlgo_ExtractBlendsFilter : public asiAlgo_ExtractFeaturesFilter
{
  // OCCT RTTI.
  DEFINE_STANDARD_RTTI_INLINE(asiAlgo_ExtractBlendsFilter, asiAlgo_ExtractFeaturesFilter)

public:

  //! If the returned flag is true, the attribute and its corresponding
  //! face is accepted.
  //! \param[in] attr AAG node attribute to check.
  //! \return true to accepts, false -- to deny.
  virtual bool operator()(const Handle(asiAlgo_FeatureAttrFace)& attr) const
  {
    Handle(asiAlgo_AttrBlendCandidate)
      bcAttr = Handle(asiAlgo_AttrBlendCandidate)::DownCast(attr);
    //
    if ( bcAttr.IsNull() )
      return false;

    // Filter by radius.
    if ( bcAttr->GetMaxRadius() > m_fMaxR )
      return false;

    return true;
  }

public:

  //! Ctor accepting the max allowed radius.
  //! \param[in] r max allowed radius to use for filtering.
  asiAlgo_ExtractBlendsFilter(const double r) : asiAlgo_ExtractFeaturesFilter(), m_fMaxR(r) {}

private:

  double m_fMaxR; //!< Max allowed radius.

};

//-----------------------------------------------------------------------------

//! Namespace for all AAG iteration rules used by blends recognizer.
namespace asiAlgo_AAGIterationRule
{
  //! This rule recognizes edge-blend faces (EBFs).
  class RecognizeEdgeBlends : public Standard_Transient
  {
    // OCCT RTTI
    DEFINE_STANDARD_RTTI_INLINE(RecognizeEdgeBlends, Standard_Transient)

  public:

    //! Ctor.
    //! \param[in] aag                attributed adjacency graph keeping information on the
    //!                               recognized properties of the model.
    //! \param[in] maxRadius          max allowed radius.
    //! \param[in] allowCones         whether to allow conical faces as EBFs.
    //! \param[in] allowLinExtrusions whether to allow linear extrusion faces as EBFs.
    //! \param[in] progress           progress notifier.
    //! \param[in] plottter           imperative plotter.
    RecognizeEdgeBlends(const Handle(asiAlgo_AAG)& aag,
                        const double               maxRadius,
                        const bool                 allowCones,
                        const bool                 allowLinExtrusions,
                        ActAPI_ProgressEntry       progress = nullptr,
                        ActAPI_PlotterEntry        plotter  = nullptr)
    //
    : m_aag(aag), m_fMaxRadius(maxRadius), m_bBlockingModeOn(true)
    {
      m_localReco = new asiAlgo_RecognizeEBF(aag, progress, plotter);
      m_localReco->SetAllowCones(allowCones);
      m_localReco->SetAllowLinearExtrusions(allowLinExtrusions);
    }

  public:

    //! Sets the faces to exclude from processing.
    //! \param[in] excluded the face IDs to exclude.
    void SetExcludedFaces(const asiAlgo_Feature& excluded)
    {
      m_excluded = excluded;
    }

    //! Enables blocking mode of the rule.
    void SetBlockingOn()
    {
      m_bBlockingModeOn = true;
    }

    //! Disables blocking mode of the rule.
    void SetBlockingOff()
    {
      m_bBlockingModeOn = false;
    }

    //! Iteration rule.
    bool IsBlocking(const int seed)
    {
      return this->IsBlocking(seed, seed);
    }

    //! Iteration rule.
    //! \param[in] current 1-based ID of the current face.
    //! \param[in] next    1-based ID of the possible next face.
    //! \return true if the face in question is a gatekeeper for further iteration.
    bool IsBlocking(const int asiAlgo_NotUsed(current),
                    const int next)
    {
      if ( m_excluded.Contains(next) )
        return false;

      // If there are some nodal attributes for this face, we check whether
      // it has already been recognized as a blend candidate.
      if ( m_aag->HasNodeAttributes(next) )
      {
        Handle(asiAlgo_FeatureAttr)
          attr = m_aag->GetNodeAttribute( next, asiAlgo_AttrBlendCandidate::GUID() );
        //
        if ( !attr.IsNull() )
          return false; // Allow further iteration.
      }

      // If we are here, then the face in question is not attributed. We can now
      // try to recognize it.
      if ( !m_localReco->Perform(next, m_fMaxRadius) )
        return m_bBlockingModeOn; // Block further iterations if blocking mode is on.

      return false;
    }

  protected:

    Handle(asiAlgo_AAG)          m_aag;             //!< AAG instance.
    Handle(asiAlgo_RecognizeEBF) m_localReco;       //!< Local recognizer.
    double                       m_fMaxRadius;      //!< Max allowed radius.
    bool                         m_bBlockingModeOn; //!< Blocking mode.
    asiAlgo_Feature              m_excluded;        //!< Excluded faces.
  };

  //! This rule recognizes vertex-blend faces (VBFs).
  class RecognizeVertexBlends : public Standard_Transient
  {
    // OCCT RTTI
    DEFINE_STANDARD_RTTI_INLINE(RecognizeVertexBlends, Standard_Transient)

  public:

    //! Ctor.
    //! \param[in] aag      attributed adjacency graph keeping information on the
    //!                     recognized properties of the model.
    //! \param[in] progress progress notifier.
    //! \param[in] plottter imperative plotter.
    RecognizeVertexBlends(const Handle(asiAlgo_AAG)& aag,
                          ActAPI_ProgressEntry       progress,
                          ActAPI_PlotterEntry        plotter)
    : m_aag(aag), m_bBlockingModeOn(true)
    {
      m_localReco = new asiAlgo_RecognizeVBF(aag, progress, plotter);
    }

  public:

    //! Sets the faces to exclude from processing.
    //! \param[in] excluded the face IDs to exclude.
    void SetExcludedFaces(const asiAlgo_Feature& excluded)
    {
      m_excluded = excluded;
    }

    //! Enables blocking mode of the rule.
    void SetBlockingOn()
    {
      m_bBlockingModeOn = true;
    }

    //! Disables blocking mode of the rule.
    void SetBlockingOff()
    {
      m_bBlockingModeOn = false;
    }

    //! Iteration rule.
    bool IsBlocking(const int seed)
    {
      return this->IsBlocking(seed, seed);
    }

    //! Iteration rule.
    //! \param[in] current 1-based ID of the current face.
    //! \param[in] next    1-based ID of the possible next face.
    //! \return true if the face in question is a gatekeeper for further iteration.
    bool IsBlocking(const int asiAlgo_NotUsed(current),
                    const int next)
    {
      if ( m_excluded.Contains(next) )
        return false;

      // Try recognizing the face even if it has been already attributed.
      // At this stage, we can precise EBFs as VBFs.
      if ( !m_localReco->Perform(next) )
        return m_bBlockingModeOn; // Block further iterations if blocking mode is on.

      return false;
    }

  protected:

    Handle(asiAlgo_AAG)          m_aag;             //!< AAG instance.
    Handle(asiAlgo_RecognizeVBF) m_localReco;       //!< Local recognizer.
    bool                         m_bBlockingModeOn; //!< Blocking mode.
    asiAlgo_Feature              m_excluded;        //!< Excluded faces.
  };

  //! This rule converts terminating edges to cross edges if the terminating
  //! edges connect blend candidate faces.
  class TerminatingEdges2CrossEdges : public Standard_Transient
  {
    // OCCT RTTI
    DEFINE_STANDARD_RTTI_INLINE(TerminatingEdges2CrossEdges, Standard_Transient)

  public:

    //! Ctor.
    //! \param[in] aag      attributed adjacency graph keeping information on the
    //!                     recognized properties of the model.
    //! \param[in] progress progress notifier.
    //! \param[in] plottter imperative plotter.
    TerminatingEdges2CrossEdges(const Handle(asiAlgo_AAG)& aag,
                                ActAPI_ProgressEntry       progress,
                                ActAPI_PlotterEntry        plotter)
    : m_aag(aag)
    {}

  public:

    //! Iteration rule.
    bool IsBlocking(const int seed)
    {
      return this->IsBlocking(seed, seed);
    }

    //! Iteration rule.
    //! \param[in] current 1-based ID of the current face.
    //! \param[in] next    1-based ID of the possible next face.
    //! \return true if the face in question is a gatekeeper for further iteration.
    bool IsBlocking(const int asiAlgo_NotUsed(current),
                    const int next)
    {
      // Get attribute.
      Handle(asiAlgo_AttrBlendCandidate)
        bc = Handle(asiAlgo_AttrBlendCandidate)::DownCast( m_aag->GetNodeAttribute( next, asiAlgo_AttrBlendCandidate::GUID() ) );
      //
      if ( bc.IsNull() )
        return false;

      // Iterate over the terminating edges.
      TColStd_PackedMapOfInteger suspectedTermEdges;
      for ( TColStd_MapIteratorOfPackedMapOfInteger eit(bc->TerminatingEdgeIndices); eit.More(); eit.Next() )
      {
        // Get edge.
        const int   eid  = eit.Key();
        TopoDS_Edge edge = TopoDS::Edge( m_aag->RequestMapOfEdges()(eid) );

        // Get neighbors of the current face.
        bool isTermConfirmed = true;
        TColStd_PackedMapOfInteger neighbors = m_aag->GetNeighborsThru(next, edge);
        //
        for ( TColStd_MapIteratorOfPackedMapOfInteger nit(neighbors); nit.More(); nit.Next() )
        {
          const int nid = nit.Key();
          //
          if ( !m_aag->GetNodeAttribute( nid, asiAlgo_AttrBlendCandidate::GUID() ).IsNull() )
          {
            isTermConfirmed = false;
            break;
          }
        }

        if ( !isTermConfirmed )
          suspectedTermEdges.Add(eid);
      }

      // Override terminating edges.
      bc->CrossEdgeIndices.Unite(suspectedTermEdges);
      bc->TerminatingEdgeIndices.Subtract(suspectedTermEdges);

      return false;
    }

  protected:

    Handle(asiAlgo_AAG) m_aag; //!< AAG instance.
  };
}

//-----------------------------------------------------------------------------

asiAlgo_RecognizeBlends::asiAlgo_RecognizeBlends(const TopoDS_Shape&  masterCAD,
                                                 ActAPI_ProgressEntry progress,
                                                 ActAPI_PlotterEntry  plotter)
//
: asiAlgo_Recognizer    (masterCAD, nullptr, progress, plotter),
  m_bAllowCones         (true),
  m_bAllowLinExtrusions (false)
{}

//-----------------------------------------------------------------------------

asiAlgo_RecognizeBlends::asiAlgo_RecognizeBlends(const TopoDS_Shape&        masterCAD,
                                                 const Handle(asiAlgo_AAG)& aag,
                                                 ActAPI_ProgressEntry       progress,
                                                 ActAPI_PlotterEntry        plotter)
//
: asiAlgo_Recognizer    (masterCAD, aag, progress, plotter),
  m_bAllowCones         (true),
  m_bAllowLinExtrusions (false)
{}

//-----------------------------------------------------------------------------

asiAlgo_RecognizeBlends::asiAlgo_RecognizeBlends(const Handle(asiAlgo_AAG)& aag,
                                                 ActAPI_ProgressEntry       progress,
                                                 ActAPI_PlotterEntry        plotter)
//
: asiAlgo_Recognizer    (aag->GetMasterShape(), aag, progress, plotter),
  m_bAllowCones         (true),
  m_bAllowLinExtrusions (false)
{}

//-----------------------------------------------------------------------------

void asiAlgo_RecognizeBlends::SetAllowCones(const bool on)
{
  m_bAllowCones = on;
}

//-----------------------------------------------------------------------------

void asiAlgo_RecognizeBlends::SetAllowLinearExtrusions(const bool on)
{
  m_bAllowLinExtrusions = on;
}

//-----------------------------------------------------------------------------

void asiAlgo_RecognizeBlends::SetExcludedFaces(const asiAlgo_Feature& excluded)
{
  m_excluded = excluded;
}

//-----------------------------------------------------------------------------

bool asiAlgo_RecognizeBlends::Perform(const double radius)
{
  /* ===========================================
   *  Stage 1: build AAG (if not yet available)
   * =========================================== */

  // Build master AAG if necessary.
  if ( m_aag.IsNull() )
  {
#if defined COUT_DEBUG
    TIMER_NEW
    TIMER_GO
#endif

    // We do not allow smooth transitions here.
    m_aag = new asiAlgo_AAG(m_master, false);

#if defined COUT_DEBUG
    TIMER_FINISH
    TIMER_COUT_RESULT_MSG("Construct AAG")
#endif
  }

  /* =====================================================
   *  Stage 2: iterate AAG attempting to recognize blends
   * ===================================================== */

  // Propagation rule.
  Handle(asiAlgo_AAGIterationRule::RecognizeEdgeBlends)
    ebfRule = new asiAlgo_AAGIterationRule::RecognizeEdgeBlends(m_aag,
                                                                radius,
                                                                m_bAllowCones,
                                                                m_bAllowLinExtrusions,
                                                                m_progress,
                                                                m_plotter);

  // Rule is used in non-blocking mode to allow full traverse of the model
  // by neighbors.
  ebfRule->SetBlockingOff();

  // Exclude specific faces.
  ebfRule->SetExcludedFaces(m_excluded);

  // Select seed face from those existing on the stack.
  asiAlgo_AdjacencyMx::t_mx::Iterator mxIt(m_aag->GetNeighborhood().mx);
  const int seedFaceId = mxIt.Key();

  // Prepare neighborhood iterator with customized propagation rule.
  asiAlgo_AAGNeighborsIterator<asiAlgo_AAGIterationRule::RecognizeEdgeBlends>
    ebfIt(m_aag, seedFaceId, ebfRule);
  //
  while ( ebfIt.More() )
  {
    ebfIt.Next();
  }

  /* ==================================
   *  Stage 3: recognize vertex blends
   * ================================== */

  // Propagation rule.
  Handle(asiAlgo_AAGIterationRule::RecognizeVertexBlends)
    vbfRule = new asiAlgo_AAGIterationRule::RecognizeVertexBlends(m_aag,
                                                                  m_progress,
                                                                  m_plotter);

  // Rule is used in non-blocking mode to allow full traverse of the model
  // by neighbors.
  vbfRule->SetBlockingOff();

  // Exclude specific faces.
  vbfRule->SetExcludedFaces(m_excluded);

  // Prepare neighborhood iterator with customized propagation rule.
  asiAlgo_AAGNeighborsIterator<asiAlgo_AAGIterationRule::RecognizeVertexBlends>
    vbfIt(m_aag, seedFaceId, vbfRule);
  //
  while ( vbfIt.More() )
  {
    vbfIt.Next();
  }

  /* ===========================================================
   *  Stage 4: Reconsider some terminating edges as cross edges
   * =========================================================== */

  // Propagation rule.
  Handle(asiAlgo_AAGIterationRule::TerminatingEdges2CrossEdges)
    t2cRule = new asiAlgo_AAGIterationRule::TerminatingEdges2CrossEdges(m_aag,
                                                                        m_progress,
                                                                        m_plotter);

  // Prepare neighborhood iterator with customized propagation rule.
  asiAlgo_AAGNeighborsIterator<asiAlgo_AAGIterationRule::TerminatingEdges2CrossEdges>
    t2cIt(m_aag, seedFaceId, t2cRule);
  //
  while ( t2cIt.More() )
  {
    t2cIt.Next();
  }

  /* =============================================================
   *  Stage 5: extract features from the attributes hooked in AAG
   * ============================================================= */

  // Prepare tool to extract features from AAG.
  asiAlgo_ExtractFeatures extractor(m_progress, m_plotter);
  extractor.RegisterFeatureType( FeatureType_BlendOrdinary,
                                 asiAlgo_AttrBlendCandidate::GUID() );

  // Use extraction filter.
  Handle(asiAlgo_ExtractBlendsFilter)
    filter = new asiAlgo_ExtractBlendsFilter(radius);

  // Extract features.
  Handle(asiAlgo_ExtractFeaturesResult) featureRes;
  if ( !extractor.Perform(m_aag, featureRes, filter) )
  {
    m_progress.SendLogMessage(LogErr(Normal) << "Feature extraction failed.");
    return false;
  }

  // Set result.
  featureRes->GetFaceIndices(m_result.ids);
  return true;
}

//-----------------------------------------------------------------------------

bool asiAlgo_RecognizeBlends::PerformSingleFace(const int    faceId,
                                                const double radius)
{
  if ( !faceId )
    return this->Perform(radius);

  /* ===========================================
   *  Stage 1: build AAG (if not yet available)
   * =========================================== */

  // Build master AAG if necessary.
  if ( m_aag.IsNull() )
  {
#if defined COUT_DEBUG
    TIMER_NEW
    TIMER_GO
#endif

    // We do not allow smooth transitions here.
    m_aag = new asiAlgo_AAG(m_master, false);

#if defined COUT_DEBUG
    TIMER_FINISH
    TIMER_COUT_RESULT_MSG("Construct AAG")
#endif
  }

  // Check if the passed seed face is accessible.
  if ( !m_aag->HasFace(faceId) )
  {
    m_progress.SendLogMessage(LogErr(Normal) << "Face %1 does not exist." << faceId);
    return false;
  }

  /* =====================================================
   *  Stage 2: iterate AAG attempting to recognize blends
   * ===================================================== */

  // Propagation rule.
  Handle(asiAlgo_AAGIterationRule::RecognizeEdgeBlends)
    ebfRule = new asiAlgo_AAGIterationRule::RecognizeEdgeBlends(m_aag,
                                                                radius,
                                                                m_bAllowCones,
                                                                m_bAllowLinExtrusions,
                                                                m_progress,
                                                                m_plotter);

  // Prepare neighborhood iterator with customized propagation rule.
  asiAlgo_AAGNeighborsIterator<asiAlgo_AAGIterationRule::RecognizeEdgeBlends>
    ebfIt(m_aag, faceId, ebfRule);
  //
  while ( ebfIt.More() )
  {
    ebfIt.Next();
  }

  /* ==================================
   *  Stage 3: recognize vertex blends
   * ================================== */

  // Propagation rule.
  Handle(asiAlgo_AAGIterationRule::RecognizeVertexBlends)
    vbfRule = new asiAlgo_AAGIterationRule::RecognizeVertexBlends(m_aag,
                                                                  m_progress,
                                                                  m_plotter);

  // Rule is used in non-blocking mode to allow full traverse of the model
  // by neighbors.
  vbfRule->SetBlockingOff();

  // Prepare neighborhood iterator with customized propagation rule.
  asiAlgo_AAGNeighborsIterator<asiAlgo_AAGIterationRule::RecognizeVertexBlends>
    vbfIt(m_aag, faceId, vbfRule);
  //
  while ( vbfIt.More() )
  {
    vbfIt.Next();
  }

  /* =========================================================
   *  Stage 4: override some terminating edges as cross edges
   * ========================================================= */

  // Propagation rule.
  Handle(asiAlgo_AAGIterationRule::TerminatingEdges2CrossEdges)
    t2cRule = new asiAlgo_AAGIterationRule::TerminatingEdges2CrossEdges(m_aag,
                                                                        m_progress,
                                                                        m_plotter);

  // Prepare neighborhood iterator with customized propagation rule.
  asiAlgo_AAGNeighborsIterator<asiAlgo_AAGIterationRule::TerminatingEdges2CrossEdges>
    t2cIt(m_aag, faceId, t2cRule);
  //
  while ( t2cIt.More() )
  {
    t2cIt.Next();
  }

  /* =============================================================
   *  Stage 5: extract features from the attributes hooked in AAG
   * ============================================================= */

  // Prepare tool to extract features from AAG.
  asiAlgo_ExtractFeatures extractor(m_progress, m_plotter);
  extractor.RegisterFeatureType( FeatureType_BlendOrdinary,
                                 asiAlgo_AttrBlendCandidate::GUID() );

  // Use extraction filter.
  Handle(asiAlgo_ExtractBlendsFilter)
    filter = new asiAlgo_ExtractBlendsFilter(radius);

  // Extract features.
  Handle(asiAlgo_ExtractFeaturesResult) featureRes;
  if ( !extractor.Perform(m_aag, featureRes, filter) )
  {
    m_progress.SendLogMessage(LogErr(Normal) << "Feature extraction failed.");
    return false;
  }

  // Set result.
  featureRes->GetFaceIndices(m_result.ids);
  return true;
}

//----------------------------------------------------------------------------

void asiAlgo_RecognizeBlends::GetChains(std::vector<asiAlgo_BlendChain>& chains,
                                        const double                     rDevPerc) const
{
  std::vector<asiAlgo_Feature> ccomps;

  // Prepare connected components out of the recognition result.
  m_aag->PushSubgraph(m_result.ids);
  {
    m_aag->GetConnectedComponents(ccomps);
  }
  m_aag->PopSubgraph();

  std::unordered_map<int, Handle(asiAlgo_AttrBlendCandidate)> removedVbfs;

  // Split each connected component onto the series of chains, i.e.,
  // subcomponents all having the same radius.
  for ( const auto& ccomp : ccomps )
  {
    // radius : <fids, cross-edge length>
    std::unordered_map<double, std::pair<asiAlgo_Feature, double>> byRadii;

    // Distribute feature faces by fillet radii.
    for ( asiAlgo_Feature::Iterator fit(ccomp); fit.More(); fit.Next() )
    {
      const int fid = fit.Key();

      // Get attribute.
      Handle(asiAlgo_AttrBlendCandidate)
        bc = m_aag->ATTR_NODE<asiAlgo_AttrBlendCandidate>(fid);
      //
      if ( bc.IsNull() )
        continue;

      for ( auto r : bc->Radii )
      {
        const double rr = ::RoundDouble(r*1000.)/1000.;

        // Find with tolerance.
        auto tuple =
          std::find_if(byRadii.begin(), byRadii.end(), [&](const std::pair<double, std::pair<asiAlgo_Feature, double>>& t) {
            return ( Abs(t.first - rr)*100/rr < rDevPerc );
          });

        if ( tuple == byRadii.end() )
        {
          asiAlgo_Feature feat;
          feat.Add(fid);
          //
          byRadii.insert({rr, {feat, bc->CrossLength}});
        }
        else
        {
          tuple->second.first.Add(fid);
        }
      }
    }

    // Now that we have all feature faces distributed by radii, we should
    // split them up by connectivity once again.
    std::vector<asiAlgo_BlendChain> rawChains;
    //
    for ( const auto& tuple : byRadii )
    {
      const double           r    = tuple.first;
      const asiAlgo_Feature& fids = tuple.second.first;
      const double           cel  = tuple.second.second;

      // Prepare connected components out of the recognition result.
      std::vector<asiAlgo_Feature> localChains;
      //
      m_aag->PushSubgraph(fids);
      {
        m_aag->GetConnectedComponents(localChains);
      }
      m_aag->PopSubgraph();

      // Add to the result.
      for ( const auto& localChain : localChains )
      {
        const double len = ::BlendChainLength(localChain, m_aag);

        rawChains.push_back( {localChain, {len, r, cel}} );
      }
    }

    // Do post-processing to "normalize" chains.
    for ( const auto& chain : rawChains )
    {
      // Get rid of dangling vertex blends.
      asiAlgo_BlendChain refinedChain;
      //
      m_aag->PushSubgraph(chain.first);
      {
        for ( asiAlgo_Feature::Iterator fit(chain.first); fit.More(); fit.Next() )
        {
          const int fid = fit.Key();

          // Get attribute.
          Handle(asiAlgo_AttrBlendCandidate)
            bc = m_aag->ATTR_NODE<asiAlgo_AttrBlendCandidate>(fid);
          //
          if ( bc.IsNull() )
            continue;

          if ( bc->Kind == BlendType_Vertex )
          {
            // Check the number of neighbors.
            if ( m_aag->GetNeighbors(fid).Extent() == 1 )
            {
              // This VBF is going to get removed from the chain, so let's store
              // it in the dedicated list to come back to it in the future. We want
              // to store the removed blends to see if they are not getting removed
              // completely from the result. If they are, we'll add them back specifically.
              removedVbfs.insert({fid, bc});

              continue;
            }
          }

          refinedChain.first.Add(fid);
        }
      }
      m_aag->PopSubgraph();
      //
      refinedChain.second = chain.second; // Copy the props.

      // Add to the result.
      chains.push_back(refinedChain);
    }
  }

  // Collect all face IDs that we have in the resulting chains.
  asiAlgo_Feature chainedFids;
  //
  for ( const auto& chain : chains )
  {
    chainedFids.Unite(chain.first);
  }

  // Add hunted down vertex blends (if any).
  for ( const auto& tuple : removedVbfs )
  {
    if ( !chainedFids.Contains(tuple.first) )
    {
      asiAlgo_BlendChainProps props(tuple.second->Length,
                                    tuple.second->GetMaxRadius(),
                                    tuple.second->CrossLength);

      asiAlgo_Feature oneFaceFeature;
      oneFaceFeature.Add(tuple.first);

      chains.push_back( asiAlgo_BlendChain(oneFaceFeature, props) );
    }
  }
}
