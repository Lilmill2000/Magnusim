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

#ifndef asiAlgo_SuppressBlendShell_h
#define asiAlgo_SuppressBlendShell_h

// asiAlgo includes
#include "asiAlgo_AAG.h"
#include "asiAlgo_History.h"

// Active Data includes
#include <ActAPI_IAlgorithm.h>

//-----------------------------------------------------------------------------

//! \ingroup ASI_MODELING
//!
//! Geometric operator for suppressing bends in sheet metal shells. We have
//! this function in the blending suite of Analysis Situs because such bends
//! are geometrically identical to "blends".
class asiAlgo_SuppressBlendShell : public ActAPI_IAlgorithm
{
  // OCCT RTTI
  DEFINE_STANDARD_RTTI_INLINE(asiAlgo_SuppressBlendShell, ActAPI_IAlgorithm)

public:

  //! Constructor.
  //! \param[in] shape    the full CAD model to defeature.
  //! \param[in] progress the progress notifier.
  //! \param[in] plotter  the imperative plotter.
  asiAlgo_EXPORT
    asiAlgo_SuppressBlendShell(const TopoDS_Shape&  shape,
                               ActAPI_ProgressEntry progress = nullptr,
                               ActAPI_PlotterEntry  plotter  = nullptr);

  //! Constructor with AAG.
  //! \param[in] aag      the AAG of the CAD model to defeature.
  //! \param[in] progress the progress notifier.
  //! \param[in] plotter  the imperative plotter.
  asiAlgo_EXPORT
    asiAlgo_SuppressBlendShell(const Handle(asiAlgo_AAG)& aag,
                               ActAPI_ProgressEntry       progress = nullptr,
                               ActAPI_PlotterEntry        plotter  = nullptr);

public:

  //! Performs feature suppression.
  //! \param[in] fid the 1-based ID of the bend face to suppress.
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT virtual bool
    Perform(const int fid);

public:

  //! \return modified model.
  const TopoDS_Shape& GetResult() const
  {
    return m_result;
  }

  //! \return modification history.
  const Handle(asiAlgo_History)& GetHistory() const
  {
    return m_history;
  }

  //! \brief Sets externally defined history.
  //!
  //! The passed history will not be cleared, so that a pipeline of
  //! modeling tools will grow its history graph as long as the history
  //! object is continuously passed from one tool to another.
  //!
  //! \param[in] history history to set.
  void SetHistory(const Handle(asiAlgo_History)& history)
  {
    m_history = history;
  }

protected:

  //! Constructs an extension face from the given spring edge to the intersection
  //! curve between the extended support faces.
  asiAlgo_EXPORT bool
    buildExtensionFace(const TopoDS_Edge&                         edge,
                       const Handle(asiAlgo_IntersectionCurveSS)& iCurve,
                       TopoDS_Face&                               F) const;

protected:

  Handle(asiAlgo_History) m_history; //!< Modification history.
  TopoDS_Shape            m_input;   //!< Input CAD model.
  Handle(asiAlgo_AAG)     m_aag;     //!< Input AAG.
  TopoDS_Shape            m_result;  //!< Result CAD model.

};

#endif
