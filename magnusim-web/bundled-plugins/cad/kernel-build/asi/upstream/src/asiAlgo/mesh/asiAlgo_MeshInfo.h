//-----------------------------------------------------------------------------
// Created on: 16 February 2016
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

#ifndef asiAlgo_MeshInfo_h
#define asiAlgo_MeshInfo_h

// asiAlgo includes
#include <asiAlgo.h>

// OCCT includes
#include <Poly_Triangulation.hxx>
#include <Standard_OStream.hxx>
#include <TopoDS_Shape.hxx>

//-----------------------------------------------------------------------------

//! \ingroup ASI_MODELING
//!
//! Mesh information.
struct asiAlgo_MeshInfo
{
  int    nNodes;        //!< Num. of mesh nodes.
  int    nFacets;       //!< Num of facets.
  int    nFacetedFaces; //!< Number of faceted faces.
  int    nBrepFaces;    //!< Number of B-rep faces.
  double maxDeflection; //!< Max deflection.

  //! Default ctor.
  asiAlgo_MeshInfo()
  : nNodes        (0),
    nFacets       (0),
    nFacetedFaces (0),
    nBrepFaces    (0),
    maxDeflection (0.0) {}

  //! Extracts mesh info from the passed shape and returns the mesh
  //! info structure by value.
  //! \param[in] shape the shape to consult.
  //! \return the outcome mesh info.
  asiAlgo_EXPORT static asiAlgo_MeshInfo
    Extract(const TopoDS_Shape& shape);

  //! Extracts mesh summary for the given B-Rep model.
  //! \param[in] shape OCCT shape as a container for triangulation.
  asiAlgo_EXPORT void
    ExtractInfoFrom(const TopoDS_Shape& shape);

  //! Extracts mesh summary for the given triangulation.
  //! \param mesh [in] CAD-agnostic triangulation.
  asiAlgo_EXPORT void
    ExtractInfoFrom(const Handle(Poly_Triangulation)& mesh);

  //! Dumps mesh information to the given output stream.
  //! \param[in,out] out the target output stream.
  asiAlgo_EXPORT void
    Dump(Standard_OStream& out);
};

#endif
