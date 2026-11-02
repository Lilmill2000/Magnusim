//-----------------------------------------------------------------------------
// Created on: 12 November 2021
//-----------------------------------------------------------------------------
// Copyright (c) 2021-present, Julia Slyadneva
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

#pragma once

// asiAlgo includes
#include <asiAlgo.h>

// Active Data includes
#include <ActAPI_IProgressNotifier.h>

//-----------------------------------------------------------------------------

//! \ingroup ASI_MODELING
//!
//! Counters for different types of topological primitives in a shape.
struct asiAlgo_TopoSummary
{
  int nbCompsolids;
  int nbCompounds;
  int nbSolids;
  int nbShells;
  int nbFaces;
  int nbWires;
  int nbOuterWires;
  int nbInnerWires;
  int nbEdges;
  int nbDegenEdges;
  int nbVertexes;

  //! Default ctor.
  asiAlgo_TopoSummary()
  : nbCompsolids (0),
    nbCompounds  (0),
    nbSolids     (0),
    nbShells     (0),
    nbFaces      (0),
    nbWires      (0),
    nbOuterWires (0),
    nbInnerWires (0),
    nbEdges      (0),
    nbDegenEdges (0),
    nbVertexes   (0)
  {}

  //! Nullifies all counters.
  void Reset()
  {
    nbCompsolids  = 0;
    nbCompounds   = 0,
    nbSolids      = 0;
    nbShells      = 0;
    nbFaces       = 0;
    nbWires       = 0;
    nbOuterWires  = 0;
    nbInnerWires  = 0;
    nbEdges       = 0;
    nbDegenEdges  = 0;
    nbVertexes    = 0;
  }

  //! Checks if this structure equals the passed one.
  //! \param[in] other the data structur to check against.
  //! \return true in the case of equality, false -- otherwise.
  bool IsEqual(const asiAlgo_TopoSummary& other) const
  {
    if ( nbCompsolids != other.nbCompsolids ) return false;
    if ( nbCompounds  != other.nbCompounds  ) return false;
    if ( nbSolids     != other.nbSolids     ) return false;
    if ( nbShells     != other.nbShells     ) return false;
    if ( nbFaces      != other.nbFaces      ) return false;
    if ( nbWires      != other.nbWires      ) return false;
    if ( nbOuterWires != other.nbOuterWires ) return false;
    if ( nbInnerWires != other.nbInnerWires ) return false;
    if ( nbEdges      != other.nbEdges      ) return false;
    if ( nbDegenEdges != other.nbDegenEdges ) return false;
    if ( nbVertexes   != other.nbVertexes   ) return false;
    return true;
  }

  //! Prints the summary contents to the given progress notifier.
  void Print(const std::string&   msg,
             ActAPI_ProgressEntry progress)
  {
    progress.SendLogMessage(LogInfo(Normal) << "=============================================");
    progress.SendLogMessage(LogInfo(Normal) << msg);
    progress.SendLogMessage(LogInfo(Normal) << "---------------------------------------------");
    progress.SendLogMessage(LogInfo(Normal) << "\tNum. compsolids:    %1" << nbCompsolids);
    progress.SendLogMessage(LogInfo(Normal) << "\tNum. compounds:     %1" << nbCompounds);
    progress.SendLogMessage(LogInfo(Normal) << "\tNum. solids:        %1" << nbSolids);
    progress.SendLogMessage(LogInfo(Normal) << "\tNum. shells:        %1" << nbShells);
    progress.SendLogMessage(LogInfo(Normal) << "\tNum. faces:         %1" << nbFaces);
    progress.SendLogMessage(LogInfo(Normal) << "\tNum. wires:         %1" << nbWires);
    progress.SendLogMessage(LogInfo(Normal) << "\tNum. outer wires:   %1" << nbOuterWires);
    progress.SendLogMessage(LogInfo(Normal) << "\tNum. inner edges:   %1" << nbInnerWires);
    progress.SendLogMessage(LogInfo(Normal) << "\tNum. edges:         %1" << nbEdges);
    progress.SendLogMessage(LogInfo(Normal) << "\tNum. degen edges:   %1" << nbDegenEdges);
    progress.SendLogMessage(LogInfo(Normal) << "\tNum. vertexes:      %1" << nbVertexes);
  }
};
