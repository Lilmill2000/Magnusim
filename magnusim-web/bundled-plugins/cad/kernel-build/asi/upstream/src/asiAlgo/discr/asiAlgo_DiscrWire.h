//-----------------------------------------------------------------------------
// Created on: 15 April 2022
//-----------------------------------------------------------------------------
// Copyright (c) 2022-present, Quaoar Studio LLC
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

#ifndef asiAlgo_DiscrWire_HeaderFile
#define asiAlgo_DiscrWire_HeaderFile

// asiAlgo includes
#include <asiAlgo_DiscrSequenceOfPointer.h>

// OpenCascade includes
#include <Bnd_Box2d.hxx>
#include <NCollection_Handle.hxx>

//-----------------------------------------------------------------------------

//! \ingroup ASI_CORE
//!
namespace asiAlgo {
namespace discr {

class Face;
class Edge;

//! Discrete wire as a sequence of oriented edges. A wire may represent a boundary of a face or
//! a free boundary of a shell or a sharp edges sequence or whatever user defines.
class Wire
{
public:

  //! Default ctor.
  Wire() : m_bClosed   (false),
           m_bInternal (false),
           m_bIsActive (false)
  {
    m_edges = new IMapOfPointerBoolean();
  }

public:

  //! Adds the passed edge and its "same sense" flag to the stored
  //! collection of edges.
  void AppendEdge(const Edge& edge,
                  const bool  isForward)
  {
    m_edges->Add( PairOfPEdgeBoolean((Edge*)&edge, isForward) );
  }

  //! Sets the Boolean flag indicating if this wire is closed or open.
  void SetClosed(const bool isClosed)
  {
    m_bClosed = isClosed;
  }

  //! Sets the Boolean flag indicating if this wire is internal.
  void SetInternal(const bool isInternal)
  {
    m_bInternal = isInternal;
  }

  //! Sets the Boolean flag indicating whether this wire is active.
  void SetActive(const bool isActive)
  {
    m_bIsActive = isActive;
  }

public:

  //! Computes and stores the bounding box of the wire on the face.
  asiAlgo_EXPORT void
    Update(const Face& face);

public:

  //! Returns the number of edges.
  int GetNbEdges() const
  {
    return m_edges->Size();
  }

  //! Returns an edge by index.
  const PairOfPEdgeBoolean& GetEdgeData(const int index) const
  {
    return m_edges->FindKey(index);
  }

  bool IsClosed() const
  {
    return m_bClosed;
  }

  bool IsInternal() const
  {
    return m_bInternal;
  }

  bool IsActive() const
  {
    return m_bIsActive;
  }

  //! \return AABB of the wire in the parametric space of a face.
  const Bnd_Box2d& BndBox() const
  {
    return m_box;
  }

  bool operator==(const Wire& other) const
  {
    return this == &other;
  }

  void ChangeEdges(const NCollection_Handle<IMapOfPointerBoolean>& edges)
  {
    m_edges = edges;
  }

  //! Checks if this wire contains the given edge.
  bool Contains(const Edge* edge, const bool isForward) const
  {
    return m_edges->Contains( PairOfPEdgeBoolean( (Edge*) edge, isForward ) );
  }

  //! Returns 1-based index of the given edge in the wire or 0 if such edge
  //! is not contained.
  int GetEdgeIndex(const Edge* edge, const bool isForward)
  {
    return m_edges->FindIndex(PairOfPEdgeBoolean( (Edge*) edge, isForward ) );
  }

private:

  Wire            (const Wire&);
  Wire& operator= (const Wire&);

private:

  NCollection_Handle<IMapOfPointerBoolean> m_edges;
  Bnd_Box2d                                m_box;
  bool                                     m_bClosed;
  bool                                     m_bInternal;
  bool                                     m_bIsActive;

};

}
}

#endif
