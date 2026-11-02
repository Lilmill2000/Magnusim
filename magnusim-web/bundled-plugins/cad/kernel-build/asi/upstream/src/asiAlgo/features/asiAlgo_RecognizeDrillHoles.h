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

#ifndef asiAlgo_RecognizeDrillHoles_h
#define asiAlgo_RecognizeDrillHoles_h

// asiAlgo includes
#include <asiAlgo_FeatureFaces.h>
#include <asiAlgo_Recognizer.h>

// OCCT includes
#include <Precision.hxx>

//-----------------------------------------------------------------------------

//! \ingroup ASI_AFR
//!
//! Utility to recognize drilled holes.
class asiAlgo_RecognizeDrillHoles : public asiAlgo_Recognizer
{
  // OCCT RTTI
  DEFINE_STANDARD_RTTI_INLINE(asiAlgo_RecognizeDrillHoles, asiAlgo_Recognizer)

public:

  //! Ctor.
  //! \param[in] shape    full CAD model.
  //! \param[in] doHard   indicates whether to indicate "hard" holes.
  //! \param[in] progress progress notifier.
  //! \param[in] plotter  imperative plotter.
  asiAlgo_EXPORT
    asiAlgo_RecognizeDrillHoles(const TopoDS_Shape&  shape,
                                const bool           doHard   = false,
                                ActAPI_ProgressEntry progress = nullptr,
                                ActAPI_PlotterEntry  plotter  = nullptr);

  //! Ctor.
  //! \param[in] aag      attributed adjacency graph.
  //! \param[in] doHard   indicates whether to indicate "hard" holes.
  //! \param[in] progress progress notifier.
  //! \param[in] plotter  imperative plotter.
  asiAlgo_EXPORT
    asiAlgo_RecognizeDrillHoles(const Handle(asiAlgo_AAG)& aag,
                                const bool                 doHard   = false,
                                ActAPI_ProgressEntry       progress = nullptr,
                                ActAPI_PlotterEntry        plotter  = nullptr);

public:

  //! Sets the linear tolerance to use. If not set, the tolerance will be
  //! taken from the model.
  //! \param[in] tol the tolerance to set.
  asiAlgo_EXPORT void
    SetLinearTolerance(const double tol);

  //! Sets the precision of canonical recognition to use.
  //! \param[in] prec the precision to set.
  asiAlgo_EXPORT void
    SetCanRecPrecision(const double prec);

  //! Sets hard feature recognition mode.
  asiAlgo_EXPORT void
    SetHardFeatureModeOn();

  //! Disables hard feature recognition mode.
  asiAlgo_EXPORT void
    SetHardFeatureModeOff();

  //! Sets hard features recognition mode state by the flag.
  //! \param[in] isOn the Boolean value to set.
  asiAlgo_EXPORT void
    SetHardFeatureMode(const bool isOn);

  //! Turns on/off pure conical holes detection mode.
  //! \param[in] isOn value to set.
  asiAlgo_EXPORT void
    SetPureConicalAllowed(const bool isOn);

  //! Sets a set of seed faces to start the recognition from. If seed faces are
  //! not specified, the algorithm will traverse the entire AAG trying each
  //! face as a seed one.
  //! \param[in] fids the face IDs to use as seeds.
  asiAlgo_EXPORT void
    SetSeedFaceIds(const TColStd_PackedMapOfInteger& fids);

  //! Sets the collection of face IDs to exclude from the consideration.
  //! Use this method to narrow down the candidate list of the seed faces.
  //! \param[in] fids the face IDs to exclude from the collection of seeds.
  asiAlgo_EXPORT void
    SetFaceIdsToExclude(const TColStd_PackedMapOfInteger& fids);

public:

  //! Performs recognition.
  //! \param[in] radius max radius (infinite by default).
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    Perform(const double radius = Precision::Infinite());

protected:

  //! Iterates AAG and recognizes features.
  //! \param[in] radius max radius.
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    performInternal(const double radius);

  //! Extension point for derived classes to provide their feature
  //! matching logic.
  //! \param[in]  cc      the connected component representing the reduced
  //!                     problem graph to apply matching on.
  //! \param[out] feature the found features.
  asiAlgo_EXPORT virtual void
    matchConnectedComponent(const Handle(asiAlgo_AAG)& cc,
                            asiAlgo_Feature&           feature) override;

protected:

  double                     m_fLinToler;      //!< Linear tolerance to use.
  double                     m_fCanRecPrec;    //!< Precision of canonical recognition.
  bool                       m_bHardMode;      //!< Hard feature mode (on/off).
  bool                       m_bPureConicalOn; //!< Pure conical holes will be detected in this mode.
  TColStd_PackedMapOfInteger m_seeds;          //!< IDs of the user-defined seed faces.
  TColStd_PackedMapOfInteger m_xSeeds;         //!< IDs of the excluded faces.

};

#endif
