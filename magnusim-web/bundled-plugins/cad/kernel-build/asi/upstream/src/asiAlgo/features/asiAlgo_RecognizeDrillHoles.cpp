//-----------------------------------------------------------------------------
// Copyright (c) 2017-present, Sergey Slyadnev
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
#include <asiAlgo_RecognizeDrillHoles.h>

// asiAlgo includes
#include <asiAlgo_AAG.h>
#include <asiAlgo_Isomorphism.h>
#include <asiAlgo_RecognizeDrillHolesRule.h>

// OCCT includes
#include <TColStd_MapIteratorOfPackedMapOfInteger.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>

#undef COUT_DEBUG
#if defined COUT_DEBUG
  #pragma message("===== warning: COUT_DEBUG is enabled")
#endif

//-----------------------------------------------------------------------------

asiAlgo_RecognizeDrillHoles::asiAlgo_RecognizeDrillHoles(const TopoDS_Shape&  shape,
                                                         const bool           doHard,
                                                         ActAPI_ProgressEntry progress,
                                                         ActAPI_PlotterEntry  plotter)
//
: asiAlgo_Recognizer (shape, nullptr, progress, plotter),
  m_fLinToler        (0.),
  m_fCanRecPrec      (1.e-3),
  m_bHardMode        (doHard),
  m_bPureConicalOn   (true)
{}

//-----------------------------------------------------------------------------

asiAlgo_RecognizeDrillHoles::asiAlgo_RecognizeDrillHoles(const Handle(asiAlgo_AAG)& aag,
                                                         const bool                 doHard,
                                                         ActAPI_ProgressEntry       progress,
                                                         ActAPI_PlotterEntry        plotter)
//
: asiAlgo_Recognizer (aag, progress, plotter),
  m_fLinToler        (0.),
  m_fCanRecPrec      (1.e-3),
  m_bHardMode        (doHard),
  m_bPureConicalOn   (true)
{}

//-----------------------------------------------------------------------------

void asiAlgo_RecognizeDrillHoles::SetLinearTolerance(const double tol)
{
  m_fLinToler = tol;
}

//-----------------------------------------------------------------------------

void asiAlgo_RecognizeDrillHoles::SetCanRecPrecision(const double prec)
{
  m_fCanRecPrec = prec;
}

//-----------------------------------------------------------------------------

void asiAlgo_RecognizeDrillHoles::SetHardFeatureMode(const bool isOn)
{
  m_bHardMode = isOn;
}

//-----------------------------------------------------------------------------

void asiAlgo_RecognizeDrillHoles::SetHardFeatureModeOn()
{
  m_bHardMode = true;
}

//-----------------------------------------------------------------------------

void asiAlgo_RecognizeDrillHoles::SetHardFeatureModeOff()
{
  m_bHardMode = false;
}

//-----------------------------------------------------------------------------

void asiAlgo_RecognizeDrillHoles::SetPureConicalAllowed(const bool isOn)
{
  m_bPureConicalOn = isOn;
}

//-----------------------------------------------------------------------------

void asiAlgo_RecognizeDrillHoles::SetSeedFaceIds(const TColStd_PackedMapOfInteger& fids)
{
  m_seeds = fids;
}

//-----------------------------------------------------------------------------

void asiAlgo_RecognizeDrillHoles::SetFaceIdsToExclude(const TColStd_PackedMapOfInteger& fids)
{
  m_xSeeds = fids;
}

//-----------------------------------------------------------------------------

bool asiAlgo_RecognizeDrillHoles::Perform(const double radius)
{
  if ( !this->performInternal(radius) )
    return false;

  return true;
}

//-----------------------------------------------------------------------------

bool asiAlgo_RecognizeDrillHoles::performInternal(const double radius)
{
  // Clean up the result.
  m_result.faces.Clear();
  m_result.ids.Clear();

  /* ====================
   *  Stage 1: build AAG
   * ==================== */

  // Build master AAG.
  if ( m_aag.IsNull() )
  {
#if defined COUT_DEBUG
    TIMER_NEW
    TIMER_GO
#endif

    // We do not allow smooth transitions here. Indeed, holes are very often
    // represented by several pieces of smoothly joint cylindrical
    // surfaces. Such paving allows getting rid of periodic geometry,
    // and that is why many modelers prefer to use it.
    m_aag = new asiAlgo_AAG(m_master, false);

#if defined COUT_DEBUG
    TIMER_FINISH
    TIMER_COUT_RESULT_MSG("Construct AAG")
#endif
  }

  /* ===========================
   *  Stage 2: recognition loop
   * =========================== */

#if defined COUT_DEBUG
  TIMER_NEW
  TIMER_GO
#endif

  TColStd_PackedMapOfInteger traversed;

  // Iterate over the entire AAG in a random manner looking for
  // specific patterns.
  // ...

  Handle(asiAlgo_AAGIterator) seed_it;
  //
  if ( !m_seeds.IsEmpty() )
  {
    seed_it = new asiAlgo_AAGSetIterator(m_aag, m_seeds);
  }
  else
  {
    seed_it = new asiAlgo_AAGRandomIterator(m_aag);
  }

  // Linear tolerance to use.
  double linToler;
  //
  if ( m_fLinToler < Precision::Confusion() )
    linToler = BRep_Tool::MaxTolerance(m_aag->GetMasterShape(), TopAbs_EDGE);
  else
    linToler = m_fLinToler;

  Handle(asiAlgo_RecognizeDrillHolesRule)
    rule = new asiAlgo_RecognizeDrillHolesRule(seed_it,
                                               radius,
                                               m_progress,
                                               m_plotter);
  //
  rule->SetLinearTolerance    (linToler);
  rule->SetCanRecPrecision    (m_fCanRecPrec);
  rule->SetHardFeatureMode    (m_bHardMode); // Turn on/off hard feature detection.
  rule->SetPureConicalAllowed (m_bPureConicalOn);

  // Run the main recognition loop. Any face is a seed, we let the rule decide.
  for ( ; seed_it->More(); seed_it->Next() )
  {
    const int fid = seed_it->GetFaceId();

    // Recognizer iterates some faces internally. We don't want to
    // use such faces as seeds, so we skip them here. Alternatively,
    // a face might have been forcible excluded from the consideration.
    if ( traversed.Contains(fid) || m_xSeeds.Contains(fid) )
      continue;

    // Attempt to recognize.
    if ( rule->Recognize(m_result.faces, m_result.ids) )
    {
      // Pick up those faces iterated by the recognizer and exclude them
      // from the list to iterate.
      traversed.Unite( rule->JustTraversed() );
    }

    // Progress.
    if ( m_progress.IsCancelling() )
      return false;
  }

  /* ======================================================
   *  Stage 3: complete detection with floating isolations
   * ====================================================== */

  // Reset iterator.
  if ( !m_seeds.IsEmpty() )
  {
    Handle(asiAlgo_AAGSetIterator)::DownCast(seed_it)->Init(m_aag, m_seeds);
  }
  else
  {
    Handle(asiAlgo_AAGRandomIterator)::DownCast(seed_it)->Init(m_aag);
  }

  // Complete recognition.
  for ( ; seed_it->More(); seed_it->Next() )
  {
    const int currentFid = seed_it->GetFaceId();
    //
    if ( m_result.ids.Contains(currentFid) )
      continue;

    const TopoDS_Face& currentFace = m_aag->GetFace(currentFid);

    // Get neighbors and check if all them have been detected as feature
    // faces. If so, then current face is in "floating isolation", so we
    // add it to the feature list.
    TColStd_PackedMapOfInteger current_neighbors;
    seed_it->GetNeighbors(current_neighbors);
    //
    bool isFloatingIsolation = true;
    //
    for ( TColStd_MapIteratorOfPackedMapOfInteger nit(current_neighbors); nit.More(); nit.Next() )
    {
      const int neighbor_id = nit.Key();
      //
      if ( !m_result.ids.Contains(neighbor_id) )
      {
        isFloatingIsolation = false;
        break;
      }
    }

    if ( isFloatingIsolation )
    {
      bool isPlateauEnding = false;
      //
      if ( asiAlgo_Utils::IsPlanar(currentFace, false) && current_neighbors.Extent() )
      {
        // For a planar face, its outer wire should have hole feature faces attached.
        // If that's not the case, there's something strange with such a planar ending
        // and we do not want to have it in the recognition result.

        TColStd_PackedMapOfInteger eids;
        TopoDS_Wire                W = asiAlgo_Utils::CacheOuterWire(currentFid, m_aag);
        //
        for ( TopExp_Explorer eexp(W, TopAbs_EDGE); eexp.More(); eexp.Next() )
        {
          const int eid = m_aag->RequestMapOfEdges().FindIndex( eexp.Current() );
          eids.Add(eid);
        }

        asiAlgo_Feature currentNids = m_aag->GetNeighborsThru(currentFid, eids);
        //
        if ( currentNids.IsEmpty() )
        {
          isPlateauEnding = true;
        }
      }

      if ( !isPlateauEnding )
      {
        m_result.faces.Add( seed_it->GetGraph()->GetFace(currentFid) );
        m_result.ids.Add(currentFid);
      }
    }

    // Progress.
    if ( m_progress.IsCancelling() )
      return false;
  }

#if defined COUT_DEBUG
  TIMER_FINISH
  TIMER_COUT_RESULT_MSG("Recognize holes")
#endif

  return true; // Success.
}

//-----------------------------------------------------------------------------

void asiAlgo_RecognizeDrillHoles::matchConnectedComponent(const Handle(asiAlgo_AAG)& asiAlgo_NotUsed(cc),
                                                          asiAlgo_Feature&           asiAlgo_NotUsed(feature))
{
  // Left for customization in app-specific code.
}
