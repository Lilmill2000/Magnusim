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
#include <asiAlgo_Recognizer.h>

// asiAlgo includes
#include <asiAlgo_AAG.h>

//-----------------------------------------------------------------------------

asiAlgo_Recognizer::asiAlgo_Recognizer(const TopoDS_Shape&        masterCAD,
                                       const Handle(asiAlgo_AAG)& aag,
                                       ActAPI_ProgressEntry       progress,
                                       ActAPI_PlotterEntry        plotter)
//
: ActAPI_IAlgorithm ( progress, plotter ),
  m_master          ( masterCAD ),
  m_aag             ( aag )
{}

//-----------------------------------------------------------------------------

asiAlgo_Recognizer::asiAlgo_Recognizer(const Handle(asiAlgo_AAG)& aag,
                                       ActAPI_ProgressEntry       progress,
                                       ActAPI_PlotterEntry        plotter)
//
: ActAPI_IAlgorithm ( progress, plotter ),
  m_master          ( aag->GetMasterShape() ),
  m_aag             ( aag )
{}

//-----------------------------------------------------------------------------

asiAlgo_Recognizer::asiAlgo_Recognizer(ActAPI_ProgressEntry progress,
                                       ActAPI_PlotterEntry  plotter)
//
: ActAPI_IAlgorithm ( progress, plotter )
{}

//-----------------------------------------------------------------------------

asiAlgo_Recognizer::~asiAlgo_Recognizer()
{}

//-----------------------------------------------------------------------------

void asiAlgo_Recognizer::Init(const TopoDS_Shape& masterCAD)
{
  // Clean up and reinitialize inputs.
  m_master = masterCAD;
  m_aag.Nullify(); // AAG is not relevant anymore.

  // Clean up result.
  m_result.Clear();
}

//-----------------------------------------------------------------------------

bool asiAlgo_Recognizer::Classify(asiAlgo_Feature& feature,
                                  const bool       indicateProgress)
{
  // Contract check.
  if ( m_result.ids.IsEmpty() )
  {
    return true; // Nothing to classify.
  }

  // Narrow down the search space.
  Handle(asiAlgo_AAG) G = m_aag;
  //
  G->PushSubgraph(m_result.ids);
  {
    std::vector<asiAlgo_Feature> ccomps;
    G->GetConnectedComponents(ccomps);

    m_progress.SendLogMessage( LogInfo(Normal) << "There are %1 connected components to analyze."
                                               << int( ccomps.size() ) );

    if ( indicateProgress )
    {
      m_progress.SetMessageKey("Searching for isomorphisms");
      m_progress.Init( ccomps.size() == 1 ? INT_MAX : int( ccomps.size() ) );
    }

    // Iterate over the connected components.
    for ( auto cit = ccomps.cbegin();
          cit != ccomps.cend() && !m_progress.IsCancelling();
          ++cit )
    {
      const asiAlgo_Feature& featureFids = *cit;

      // Recognize features in each connected component separately.
      G->PushSubgraph(featureFids);
      {
        this->matchConnectedComponent(G, feature);
      }
      G->PopSubgraph(); // Pop connected component.

      if ( indicateProgress )
        m_progress.StepProgress(1);
    } // Loop for connected components.
  }
  G->PopSubgraph(); // Pop cylindrical holes.

  m_progress.SendLogMessage( LogInfo(Normal) << "Found %1 isomorphous face(s)."
                                             << feature.Extent() );

  if ( indicateProgress )
    m_progress.SetProgressStatus(ActAPI_ProgressStatus::Progress_Succeeded);

  return true;
}

//-----------------------------------------------------------------------------

TopTools_IndexedMapOfShape& asiAlgo_Recognizer::ChangeResultFaces()
{
  return m_result.faces;
}

//-----------------------------------------------------------------------------

const TopTools_IndexedMapOfShape& asiAlgo_Recognizer::GetResultFaces() const
{
  return m_result.faces;
}

//-----------------------------------------------------------------------------

asiAlgo_Feature& asiAlgo_Recognizer::ChangeResultIndices()
{
  return m_result.ids;
}

//-----------------------------------------------------------------------------

const asiAlgo_Feature& asiAlgo_Recognizer::GetResultIndices() const
{
  return m_result.ids;
}

//-----------------------------------------------------------------------------

const Handle(asiAlgo_AAG)& asiAlgo_Recognizer::GetAAG() const
{
  return m_aag;
}

//-----------------------------------------------------------------------------

void asiAlgo_Recognizer::SetAAG(const Handle(asiAlgo_AAG)& aag)
{
  m_aag = aag;
}

//-----------------------------------------------------------------------------

void asiAlgo_Recognizer::matchConnectedComponent(const Handle(asiAlgo_AAG)&,
                                                 asiAlgo_Feature&)
{
  // Nothing is in base implementation. Subclass to provide your matching logic.
}
