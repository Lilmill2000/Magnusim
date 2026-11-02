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

#ifndef asiAlgo_RecognitionRule_h
#define asiAlgo_RecognitionRule_h

// asiAlgo includes
#include <asiAlgo_AAGIterator.h>

// Active Data includes
#include <ActAPI_IAlgorithm.h>

// OCCT includes
#include <TopTools_IndexedMapOfShape.hxx>

//-----------------------------------------------------------------------------

//! \ingroup ASI_AFR
//!
//! Abstract class for feature recognition rules used in recognizers. The idea
//! behind any "rule" is to provide the recognition logic at certain AAG iterator's
//! position. I.e., whenever we are at the rule's `recognize()` method, we start from
//! an externally defined position of a "cursor" pointing to the candidate seed face.
//! Therefore, a rule itself is not bothered with selection of seed faces (the latter
//! is done by the caller code).
class asiAlgo_RecognitionRule : public ActAPI_IAlgorithm
{
public:

  DEFINE_STANDARD_RTTI_INLINE(asiAlgo_RecognitionRule, ActAPI_IAlgorithm)

public:

  //! Constructs the base rule initializing it with the given AAG iterator.
  //! \param[in] it       AAG iterator.
  //! \param[in] progress progress entry.
  //! \param[in] plotter  plotter entry.
  asiAlgo_RecognitionRule(const Handle(asiAlgo_AAGIterator)& it,
                          ActAPI_ProgressEntry               progress,
                          ActAPI_PlotterEntry                plotter)
  //
  : ActAPI_IAlgorithm(progress, plotter)
  {
    m_it = it;
  }

public:

  //! \return faces traversed during recognition.
  const asiAlgo_Feature& JustTraversed() const
  {
    return m_traversed;
  }

  //! Sets faces as traversed.
  //! \param[in] fid index of the just traversed face.
  void SetTraversed(const int fid)
  {
    m_traversed.Add(fid);
  }

  //! Adds the passed face IDs to the traversed set.
  //! \param[in] fids the IDs to add.
  void AddTraversed(const asiAlgo_Feature& fids)
  {
    m_traversed.Unite(fids);
  }

  //! Checks whether the passed face has been traversed.
  //! \param[in] fid the index to check.
  //! \return true/false.
  bool IsTraversed(const int fid) const
  {
    return m_traversed.Contains(fid);
  }

  //! Performs recognition.
  //! \param[out] featureFaces   detected faces.
  //! \param[out] featureIndices indices of the detected faces.
  //! \return true in case of success, false -- otherwise.
  bool Recognize(TopTools_IndexedMapOfShape& featureFaces,
                 asiAlgo_Feature&            featureIndices)
  {
    m_traversed.Clear();
    //
    return this->recognize(featureFaces, featureIndices);
  }

private:

  //! Extension point for the derived classes to do real job.
  virtual bool
    recognize(TopTools_IndexedMapOfShape& featureFaces,
              asiAlgo_Feature&            featureIndices) = 0;

protected:

  Handle(asiAlgo_AAGIterator) m_it;        //!< AAG iterator.
  asiAlgo_Feature             m_traversed; //!< Faces traversed during recognition.

};

#endif
