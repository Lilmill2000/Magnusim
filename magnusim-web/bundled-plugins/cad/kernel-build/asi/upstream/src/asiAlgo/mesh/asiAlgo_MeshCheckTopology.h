//-----------------------------------------------------------------------------
// Created on: 04 December 2021
//-----------------------------------------------------------------------------
// Copyright (c) 2021-present, Sergey Slyadnev
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

#ifndef asiAlgo_MeshCheckTopology_h
#define asiAlgo_MeshCheckTopology_h

// asiAlgo includes
#include <asiAlgo.h>

// Active Data includes
#include <ActAPI_IProgressNotifier.h>
#include <ActAPI_IPlotter.h>

// OpenCascade includes
#include <NCollection_IndexedDataMap.hxx>
#include <TColStd_HSequenceOfInteger.hxx>
#include <TColStd_SequenceOfReal.hxx>
#include <TopoDS_Shape.hxx>

//-----------------------------------------------------------------------------

//! \ingroup ASI_MODELING
//!
//! This utility class checks the topology of the `Poly_Triangulation` meshes
//! distributed by B-rep faces. The following errors are reported:
//!
//! - free links. A link is considered free if it has only one
//!   neighboring triangle and at least one of its nodes belongs to
//!   interior of the face rather than to its boundary.
//!
//! - cross face errors. It is a situation when a point on a common
//!   boundary between two faces has different 3d coordinates on each
//!   triangulation. The error is reported if the distance is greater
//!   than a deflection written in triangulations.
//!
//! - asynchronous edges. It is an edge having polygons on two neighboring
//!   triangulations with different number of points in the polygons.
//!
//! - free nodes -- nodes not shared by any triangle.
class asiAlgo_MeshCheckTopology
{
public:

  //! Ctor.
  asiAlgo_MeshCheckTopology(const TopoDS_Shape&  shape,
                            ActAPI_ProgressEntry progress = nullptr,
                            ActAPI_PlotterEntry  plotter  = nullptr)
  : m_shape    (shape),
    m_progress (progress),
    m_plotter  (plotter)
  {}

public:

  //! Performs check.
  asiAlgo_EXPORT void
    Perform();

public:

  //! \return the number of faces with free links.
  int NbFacesWithFL() const { return m_mapFaceLinks.Extent(); }

  //! \return the number (in the shape) of a face with free links
  //!         with the given index.
  int GetFaceNumWithFL(const int index) const
  {
    return m_mapFaceLinks.FindKey(index);
  }

  //! \return the number free links on a face with the given index.
  int NbFreeLinks(const int index) const
  {
    return m_mapFaceLinks(index)->Length() / 2;
  }

  //! Gets the numbers of nodes of a free link with the given index
  //! in the face with the given index.
  asiAlgo_EXPORT void
    GetFreeLink(const int faceIndex,
                const int linkIndex,
                int&      node1,
                int&      node2) const;

  //! returns the number of cross face errors.
  int NbCrossFaceErrors() const
  {
    return m_errorsVal.Length();
  }

  //! gets the attributes of a cross face error with the given index
  asiAlgo_EXPORT void
    GetCrossFaceError(const int index,
                      int&      face1,
                      int&      node1,
                      int&      face2,
                      int&      node2,
                      double&   value) const;

  //! returns the number of async edges
  int NbAsyncEdges() const
  {
    return m_asyncEdges.Length();
  }

  //! returns the number (in the shape) of an async edge with the given index
  int GetAsyncEdgeNum(const int index) const
  {
    return m_asyncEdges(index);
  }

  //! returns the number of free nodes
  int NbFreeNodes() const
  {
    return m_freeNodeFaces.Length();
  }

  //! returns the number of face containing the Index-th detected free node,
  //! and number of this node in the triangulation of that face
  void GetFreeNodeNum(const int index,
                      int&      faceNum,
                      int&      nodeNum) const
  {
    faceNum = m_freeNodeFaces(index);
    nodeNum = m_freeNodeNums(index);
  }

  //! Returns number of triangles with null area
  int NbSmallTriangles() const
  {
    return m_smallTrianglesFaces.Length();
  }

  //! returns the number of face containing the Index-th detected 
  //! small triangle and number of the problematic triangle in
  //! this face.
  void GetSmallTriangle(const int index,
                        int&      faceNum,
                        int&      nodeNum) const
  {
    faceNum = m_smallTrianglesFaces(index);
    nodeNum = m_smallTrianglesTriangles(index);
  }

private:

  typedef NCollection_IndexedDataMap<int,
                                     Handle(TColStd_HSequenceOfInteger)> t_linksMap;

  TopoDS_Shape              m_shape;
  t_linksMap                m_mapFaceLinks;
  TColStd_SequenceOfInteger m_errors;
  TColStd_SequenceOfReal    m_errorsVal;
  TColStd_SequenceOfInteger m_asyncEdges;
  TColStd_SequenceOfInteger m_freeNodeFaces;
  TColStd_SequenceOfInteger m_freeNodeNums;
  TColStd_SequenceOfInteger m_smallTrianglesFaces;
  TColStd_SequenceOfInteger m_smallTrianglesTriangles;

  mutable ActAPI_ProgressEntry m_progress;
  mutable ActAPI_PlotterEntry  m_plotter;

};

#endif
