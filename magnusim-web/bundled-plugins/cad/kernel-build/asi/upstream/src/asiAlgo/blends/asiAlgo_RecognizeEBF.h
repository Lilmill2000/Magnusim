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

#ifndef asiAlgo_RecognizeEBF_h
#define asiAlgo_RecognizeEBF_h

// asiAlgo includes
#include <asiAlgo_AAG.h>
#include <asiAlgo_BlendVexity.h>

// Active Data includes
#include <ActAPI_IAlgorithm.h>

// Standard includes
#include <unordered_map>

//-----------------------------------------------------------------------------

//! \ingroup ASI_AFR
//!
//! Utility to recognize blend faces of EBF type (edge-blend face).
//! This utility accepts a single face and populates the corresponding AAG
//! node with a blend candidate attribute if the recognition is successful.
class asiAlgo_RecognizeEBF : public ActAPI_IAlgorithm
{
  // OCCT RTTI
  DEFINE_STANDARD_RTTI_INLINE(asiAlgo_RecognizeEBF, ActAPI_IAlgorithm)

public:

  //! Ctor.
  //! \param[in] aag      attributed adjacency graph.
  //! \param[in] progress progress notifier.
  //! \param[in] plotter  imperative plotter.
  asiAlgo_EXPORT
    asiAlgo_RecognizeEBF(const Handle(asiAlgo_AAG)& aag,
                         ActAPI_ProgressEntry       progress,
                         ActAPI_PlotterEntry        plotter);

public:

  //! Sets a Boolean flag indicating whether conical EBFs are
  //! allowed or not. If not, all conical faces are to be skipped.
  //! \param[in] on the Boolean value to set.
  asiAlgo_EXPORT void
    SetAllowCones(const bool on);

  //! Sets a Boolean flag indicating whether linear extrusion EBFs are
  //! allowed or not. If not, all linear extrusion faces are to be skipped.
  //! \param[in] on the Boolean value to set.
  asiAlgo_EXPORT void
    SetAllowLinearExtrusions(const bool on);

  //! Sets the cache to use for computing edge lengths.
  //! \param[in] ptr the raw pointer to the cache to use.
  asiAlgo_EXPORT void
    SetEdgeLengthsCache(std::unordered_map<int, double>* ptr);

public:

  //! Performs recognition for the given face.
  //! \param[in] fid       ID of the face in question.
  //! \param[in] maxRadius max allowed radius.
  //! \return true if the face was recognized as a blend face.
  asiAlgo_EXPORT virtual bool
    Perform(const int    fid,
            const double maxRadius);

protected:

  //! Computes the length of the edge passed by its 1-based ID.
  //! \param[in] eid the edge in question.
  //! \return the computed edge's length.
  asiAlgo_EXPORT double
    testLength(const int eid) const;

  //! Computes the length of the passed train of edges.
  //! \param[in] eids the edges in question.
  //! \return the computed train's length.
  asiAlgo_EXPORT double
    testLength(const TColStd_PackedMapOfInteger& eids) const;

  //! Computes the length of a blend.
  //! \param[in] springEdges the detected spring edges.
  //! \return blend length.
  asiAlgo_EXPORT double
    computeBlendLength(const TColStd_PackedMapOfInteger& springEdges) const;

  //! Computes the length of a blend using a fallback UV-based bounds method.
  //! \param[in] fid the 1-based ID of a blend face in question.
  //! \return blend length.
  asiAlgo_EXPORT double
    computeBlendLengthFallback(const int fid) const;

  //! Evaluates blend face vexity.
  //! \param[in] fid the 1-based ID of a blend face in question.
  //! \return blend vexity.
  asiAlgo_EXPORT asiAlgo_BlendVexity
    testVexity(const int fid) const;

  //! Computes cross length for the fillet face.
  //! \param[in] fid the 1-based ID of a blend face in question.
  //! \return the computed cross-length.
  asiAlgo_EXPORT double
    computeCrossLength(const int fid) const;

protected:

  Handle(asiAlgo_AAG)              m_aag;                    //!< Attributed Adjacency Graph instance.
  std::unordered_map<int, double>* m_pEdgeLengthMap;         //!< Cached edge lengths.
  bool                             m_bAllowCones;            //!< Whether to allow conical blends.
  bool                             m_bAllowLinearExtrusions; //!< Whether to allow linear extrusion blends.

};

#endif
