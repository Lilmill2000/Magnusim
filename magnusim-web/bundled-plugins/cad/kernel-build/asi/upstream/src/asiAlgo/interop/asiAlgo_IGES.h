//-----------------------------------------------------------------------------
// Created on: 17 February 2016
//-----------------------------------------------------------------------------
// Copyright (c) 2017, Sergey Slyadnev
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
#include <ActAPI_IAlgorithm.h>

class Interface_InterfaceModel;
class Interface_CheckIterator;
class XSControl_WorkSession;
class TCollection_AsciiString;
class TopoDS_Shape;

//-----------------------------------------------------------------------------

//! \ingroup ASI_INTEROP
//!
//! IGES interoperability tool.
class asiAlgo_IGES : public ActAPI_IAlgorithm
{
  // OCCT RTTI
  DEFINE_STANDARD_RTTI_INLINE(asiAlgo_IGES, ActAPI_IAlgorithm)

public:

  //! Ctor accepting progress notifier and imperative plotter.
  //! \param[in] progress progress notifier.
  //! \param[in] plotter  imperative plotter.
  asiAlgo_IGES(ActAPI_ProgressEntry progress,
               ActAPI_PlotterEntry  plotter = nullptr)
    //
    : ActAPI_IAlgorithm(progress, plotter) {}

public:
  
  //! Performs IGES import.
  //! \param filename  [in]  file to read.
  //! \param result    [out] retrieved shape.
  //! \return true in case of success, false -- otherwise.
  asiAlgo_EXPORT bool
    Read(const TCollection_AsciiString& filename,
         TopoDS_Shape&                  result);

private:

  //! Prints statistics of warnings and fails.
  //! \param[in] model conversion model to populate problem messages.
  //! \param[in] checkIterator list of problems.
  //! \param[in] name title for set of problems.
  asiAlgo_EXPORT void printCheckStats(const Handle(Interface_InterfaceModel)& model,
                                      const Interface_CheckIterator&          checkIterator);

  //! Clears the passed Work Session object.
  //! \param[in] WS Work Session to release.
  asiAlgo_EXPORT void
    clearSession(const Handle(XSControl_WorkSession)& WS);
};
