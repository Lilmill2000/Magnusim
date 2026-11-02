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

#ifndef asiAlgo_DiscrFace_HeaderFile
#define asiAlgo_DiscrFace_HeaderFile

// asiAlgo includes
#include <asiAlgo_DiscrWire.h>

// OpenCascade includes
#include <TColStd_Array1OfTransient.hxx>

//-----------------------------------------------------------------------------

//! \ingroup ASI_CORE
//!
namespace asiAlgo {
namespace discr {

class BgrMesh;
class SegAddress;

//! Discrete face containing a triangulation (background mesh) of the underlying surface
//! and discrete boundaries (wires).
class Face
{
 public:

  // The following enumerates the algorithms that can be attached to a face
  enum AlgoKind
  {
    AKClassifier        = 0,    // classifier of a point IN, ON, OUT
    AKQuadTree          = 1,    // quadtree divider
    AKCircleBndTree     = 2,    // b-tree of circles of triangles of bgr mesh
    AKInterpolator      = 3,    // natural interpolation algo
    AKFaceBndSegTree    = 4,    // facesegboxbnd tree algo
    AKFrontSegTree      = 5,    // b-tree of segments of frontels
    AKMeshNodesMap      = 6,    // map of mesh nodes lying on face
    AKNumber            = 7     // overall number of above algorithms
  };

  // ---------- CONSTRUCTORS ----------

  asiAlgo_EXPORT Face();
  // Empty constructor

  asiAlgo_EXPORT virtual ~Face ();

  // ---------- INITIALISATION ----------

  asiAlgo_EXPORT void          InitWires (const int aNbWires);
  // Initializes internal array of wires

  asiAlgo_EXPORT void          Nullify ();
  // Brings me to be empty

  asiAlgo_EXPORT void          NullifyPCurves();
  // Destroy pcurves

  asiAlgo_EXPORT void          NullifyWiresAndAlgo();
  // Destroy algos and wires 

  asiAlgo_EXPORT void          UpdateWires ();
  // Computes 2D bounding boxes of wires, finds outer wire and
  // brings it to be first

  void SetForward (const bool isForward = true)
  { myIsForward = isForward; }
  // Sets orientation of the face

  // ---------- ACCESS TO WIRES ---------

  int              GetNbWires () const     { return myNbWires; }
  // Returns the number of wires

  inline const Wire&     GetWire (const int aIndex) const;
  // Returns a wire by index.
  // The first wire is the most outer (see UpdateWires)

  inline Wire&           ChangeWire (const int aIndex);
  // Write access to init/change a wire

  // ---------- ACCESS TO TRIANGULATION ---------

  BgrMesh&               ChangeMesh ()           { return *myMesh; }
  // Read-write access to mesh

  const BgrMesh&         Mesh    () const        { return *myMesh; }
  // Read-only access to mesh

  // ---------- ACCESS TO ATTACHED ALGORITHMS ---------

  Handle(Standard_Transient)&       ChangeAlgo (const AlgoKind aKind)
  { return myAlgos ((int) aKind); }
  const Handle(Standard_Transient)& GetAlgo    (const AlgoKind aKind) const
  { return myAlgos ((int) aKind); }

  // ---------- CONSULTING -------------

  bool              IsNull  () const        { return !myNbWires; }
  // Returns true if this face has not been yet initialized

  bool              IsForward () const { return myIsForward; }
  // Returns true if the face has forward orientation

  bool              operator == (const Face& aOther) const
  { return this == &aOther; }

  // ---------- ADDITIONAL TOOLS -------------

  asiAlgo_EXPORT bool
    FindAdjacentFace(const SegAddress& theInAddress,
                     SegAddress&       theOutAddress,
                     Face const*&      theOutFace) const;

  // Finds the adjacent face by the given segment address.
  // theOutAddress is the address of this segment on another face.
  // Returns true if face found, false if the segment is a part
  // of free boundary

  asiAlgo_EXPORT bool
    LocateEdge      (const Edge&     theEdge,
                     int&      theWireIndex,
                     int&      theEdgeIndex,
                     const bool isForward = true ) const;
  // Locates the wire and edge indices corresponding to the given edge.
  // Returns False if there are no wires which contain the edge

 private:

  Face (const Face&);
  // Hides copy constructor

  Face&                  operator = (const Face&);
  // Hides assignment operator

  // ---------- PRIVATE FIELDS ----------

  TColStd_Array1OfTransient myAlgos;
  BgrMesh*                  myMesh;
  Wire*                     myWires;
  int                       myNbWires;
  int                       myOuterWire;
  bool                      myIsForward;

};

// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
//                            INLINE METHODS
// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

//=======================================================================
//function : GetWire
//purpose  : Returns a wire by index
//=======================================================================

inline const Wire& Face::GetWire(const int aIndex) const
{
#ifdef DEB
  if (aIndex < 1 || aIndex > myNbWires)
    throw Standard_OutOfRange("asiAlgo_DiscrFace::GetWire");
#endif
  return myWires[ (aIndex == myOuterWire ? 1 :
                   aIndex == 1 && myOuterWire ? myOuterWire :
                   aIndex
                   ) - 1];
}

//=======================================================================
//function : ChangeWire
//purpose  : Write access to init/change a wire
//=======================================================================

inline Wire& Face::ChangeWire (const int aIndex)
{
#ifdef DEB
  if (aIndex < 1 || aIndex > myNbWires)
    throw Standard_OutOfRange("asiAlgo_DiscrFace::ChangeWire");
#endif
  return myWires[ (aIndex == myOuterWire ? 1 :
                   aIndex == 1 && myOuterWire ? myOuterWire :
                   aIndex
                   ) - 1];
}

}
}

#endif
