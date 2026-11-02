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

#ifndef asiAlgo_RecognizeBlends_h
#define asiAlgo_RecognizeBlends_h

// asiAlgo includes
#include <asiAlgo_BlendChain.h>
#include <asiAlgo_Recognizer.h>

//-----------------------------------------------------------------------------

//! \ingroup ASI_AFR
//!
//! Utility to recognize blends.
class asiAlgo_RecognizeBlends : public asiAlgo_Recognizer
{
  // OCCT RTTI
  DEFINE_STANDARD_RTTI_INLINE(asiAlgo_RecognizeBlends, asiAlgo_Recognizer)

public:

  //! Ctor.
  //! \param[in] masterCAD full CAD model.
  //! \param[in] progress  progress notifier.
  //! \param[in] plotter   imperative plotter.
  asiAlgo_EXPORT
    asiAlgo_RecognizeBlends(const TopoDS_Shape&  masterCAD,
                            ActAPI_ProgressEntry progress = nullptr,
                            ActAPI_PlotterEntry  plotter  = nullptr);

  //! Ctor.
  //! \param[in] masterCAD full CAD model.
  //! \param[in] aag       AAG (will be created from CAD if nullptr is passed).
  //! \param[in] progress  progress notifier.
  //! \param[in] plotter   imperative plotter.
  asiAlgo_EXPORT
    asiAlgo_RecognizeBlends(const TopoDS_Shape&        masterCAD,
                            const Handle(asiAlgo_AAG)& aag,
                            ActAPI_ProgressEntry       progress = nullptr,
                            ActAPI_PlotterEntry        plotter  = nullptr);

  //! Ctor.
  //! \param[in] aag      AAG (should not be nullptr here).
  //! \param[in] progress progress notifier.
  //! \param[in] plotter  imperative plotter.
  asiAlgo_EXPORT
    asiAlgo_RecognizeBlends(const Handle(asiAlgo_AAG)& aag,
                            ActAPI_ProgressEntry       progress = nullptr,
                            ActAPI_PlotterEntry        plotter  = nullptr);

public:

  //! Sets a Boolean flag indicating whether conical EBFs are
  //! allowed or not. If not, all conical faces are to be skipped.
  //! \param[in] on the Boolean value to set.
  asiAlgo_EXPORT void
    SetAllowCones(const bool on);

  //! Sets a Boolean flag indicating whether linear extrustion EBFs are
  //! allowed or not. If not, all linear extrustion faces are to be skipped.
  //! \param[in] on the Boolean value to set.
  asiAlgo_EXPORT void
    SetAllowLinearExtrusions(const bool on);

  //! Sets the collection of face IDs to exclude from recognition. Use this
  //! method to pass any already recognized features, e.g., drilled holes,
  //! engravings, etc.
  //! \param[in] excluded the face IDs to set.
  asiAlgo_EXPORT void
    SetExcludedFaces(const asiAlgo_Feature& excluded);

  //! Performs recognition of fillets for the entire model.
  //! \param[in] radius radius of interest.
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT virtual bool
    Perform(const double radius = 1e100);

  //! Performs fillet recognition for the given single face.
  //! \param[in] faceId 1-based ID of the target face.
  //! \param[in] radius radius of interest.
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT virtual bool
    PerformSingleFace(const int    faceId,
                      const double radius = 1e100);

  //! Extracts fillet chains with their properties.
  //! This method should be called after `Perform()`, i.e.,
  //! when the recognition result gets available.
  //! \param[out] chains   the extracted fillet chains with their props.
  //! \param[in]  rDevPerc the max allowed deviation (in percents) between the consequent
  //!                      blend faces that would allow joining them into chains and compensate
  //!                      for possible slight deviations in their fillet radii.
  asiAlgo_EXPORT void
    GetChains(std::vector<asiAlgo_BlendChain>& chains,
              const double                     rDevPerc = 1.) const;

protected:

  bool            m_bAllowCones;         //!< Whether to allow conical EBFs.
  bool            m_bAllowLinExtrusions; //!< Whether to allow linear extrusion EBFs.
  asiAlgo_Feature m_excluded;            //!< Excluded faces.

};

#endif
