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

#ifndef asiAlgo_FindFeatureHints_h
#define asiAlgo_FindFeatureHints_h

// asiAlgo includes
#include <asiAlgo.h>

// Active Data includes
#include <ActAPI_IAlgorithm.h>

// OCCT includes
#include <Geom2d_Line.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>

//-----------------------------------------------------------------------------

//! \ingroup ASI_AFR
//!
//! Utility to detect feature hints. A feature hint is an imprint of one
//! feature on another. This utility can be helpful in finding feature
//! interactions which is known to be a major cornerstone in feature
//! identification field.
class asiAlgo_FindFeatureHints : public ActAPI_IAlgorithm
{
public:

  // OCCT RTTI
  DEFINE_STANDARD_RTTI_INLINE(asiAlgo_FindFeatureHints, ActAPI_IAlgorithm)

public:

  //! Constructor.
  //! \param[in] face     working face.
  //! \param[in] progress progress notifier.
  //! \param[in] plotter  imperative plotter.
  asiAlgo_EXPORT
    asiAlgo_FindFeatureHints(const TopoDS_Face&   face,
                             ActAPI_ProgressEntry progress,
                             ActAPI_PlotterEntry  plotter);

public:

  //! Checks whether the working face is "puzzled" in its domain.
  //! \return true/false.
  asiAlgo_EXPORT bool
    IsPuzzled();

protected:

  //! Attempts to extract line from the given edge.
  //! \param[in] edge target edge.
  //! \return geometric line or null if the edge is not of linear type.
  asiAlgo_EXPORT Handle(Geom2d_Line)
    edgeAsLine(const TopoDS_Edge& edge) const;

protected:

  TopoDS_Face m_face; //!< Working face.

};

#endif
