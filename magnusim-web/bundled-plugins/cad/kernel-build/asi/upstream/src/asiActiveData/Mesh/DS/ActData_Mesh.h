//-----------------------------------------------------------------------------
// Created on: June 2016
//-----------------------------------------------------------------------------
// Copyright (c) 2017, OPEN CASCADE SAS
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
//    * Neither the name of OPEN CASCADE SAS nor the
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
//
// Web: http://analysissitus.org
//-----------------------------------------------------------------------------

#ifndef ActData_Mesh_HeaderFile
#define ActData_Mesh_HeaderFile

// Mesh includes
#include <ActData_Mesh_MapOfMeshOrientedElement.h>
#include <ActData_Mesh_Node.h>

// OCCT includes
#include <NCollection_Sequence.hxx>
#include <Poly_Triangulation.hxx>
#include <Standard_OStream.hxx>
#include <TColStd_PackedMapOfInteger.hxx>

class ActData_Mesh_IDFactory;
class Standard_NoSuchObject;
class ActData_Mesh_ElementsIterator;
class ActData_Mesh_Element;
class gp_XYZ;

//-----------------------------------------------------------------------------

//! Structure representing a single not oriented mesh link.
struct ActData_Mesh_Link
{
  int n1, n2;

  ActData_Mesh_Link() : n1(-1), n2(-1) {}
  ActData_Mesh_Link(const int _n1, const int _n2) : n1(_n1), n2(_n2) {}

  struct Hasher
  {
    inline static int HashCode(const ActData_Mesh_Link& link,
                               const int        upper)
    {
      int key = link.n1 + link.n2;
      key += (key << 10);
      key ^= (key >> 6);
      key += (key << 3);
      key ^= (key >> 11);
      return (key & 0x7fffffff) % upper;
    }

    inline static unsigned IsEqual(const ActData_Mesh_Link& l1,
                                   const ActData_Mesh_Link& l2)
    {
      return (l1.n1 == l2.n1 && l1.n2 == l2.n2) || (l1.n1 == l2.n2 && l1.n2 == l2.n1);
    }
  };
};

//-----------------------------------------------------------------------------

DEFINE_STANDARD_HANDLE(ActData_Mesh, ActData_Mesh_Object)

//! \ingroup AD_DF
//!
//! Mesh data structure.
class ActData_Mesh : public ActData_Mesh_Object
{
public:

  // OCCT RTTI
  DEFINE_STANDARD_RTTI_INLINE(ActData_Mesh, ActData_Mesh_Object)

public:

  ActData_EXPORT ActData_Mesh(const Handle(Poly_Triangulation)& tri);

  //! create a  new mesh.   It is  possible to  specify the
  //! initial size  of elements.
  //! It is recommended  to set the size of mesh elements
  //! in the constructor to avoid too much resizing of data storage
  ActData_EXPORT ActData_Mesh(const Standard_Integer nbnodes = 10, const Standard_Integer nbedges = 10, const Standard_Integer nbfaces = 10);

  //! Destructor. Calls "Clear(Standard_False)"
  void Destruct();

  ~ActData_Mesh()
  {
    Destruct();
  }

public:

  //! Constructs a deep copy of this mesh.
  ActData_EXPORT Handle(ActData_Mesh)
    DeepCopy() const;

  //! Construct Poly_Triangulation from internal representation of mesh.
  //! return Poly_Triangulation.
  ActData_EXPORT Handle(Poly_Triangulation) GetPolyTriangulation();

  //! Remove all mesh entities from the current mesh.
  //! isClearNodes == True means that all nodes becoming free after
  //! the removal of elements are also removed. Otherwise all nodes
  //! remain in the mesh structure.
  ActData_EXPORT void Clear (const Standard_Boolean isClearNodes = Standard_True);

  //! create an instance of  MeshNode and add it to the mesh
  //! if the mesh  has a parent then the  node is also added
  //! to the parent mesh.
  //! Returns a generated ID for the created node.
  ActData_EXPORT virtual Standard_Integer AddNode (const Standard_Real x, const Standard_Real y, const Standard_Real z);

  //! create an instance of  MeshNode and add it to the mesh
  //! if the mesh  has a parent then the  node is also added
  //! to the parent mesh.
  //! returns False in case the ID already exists
  ActData_EXPORT virtual Standard_Boolean AddNodeWithID (const Standard_Real x, const Standard_Real y, const Standard_Real z, const Standard_Integer ID);

  //! create an instance of MeshEdge and add it to the mesh
  //! returns the id of the element. Returns 0 if creation failed
  ActData_EXPORT virtual Standard_Integer AddEdge (const Standard_Integer idnode1, const Standard_Integer idnode2);

  //! create an instance of MeshEdge and add it to the mesh
  ActData_EXPORT virtual Standard_Boolean AddEdgeWithID (const Standard_Integer idnode1, const Standard_Integer idnode2, const Standard_Integer ID);

  //! create an instance of MeshFace and add it to the mesh
  //! returns the id of the element. Returns 0 if creation failed
  ActData_EXPORT virtual Standard_Integer AddFace (const Standard_Integer idnode1, const Standard_Integer idnode2, const Standard_Integer idnode3);

  //! create an instance of MeshFace and add it to the mesh
  ActData_EXPORT virtual Standard_Boolean AddFaceWithID (const Standard_Integer idnode1, const Standard_Integer idnode2, const Standard_Integer idnode3, const Standard_Integer ID);

  //! create an instance of MeshFace and add it to the mesh
  //! returns the id of the element. Returns 0 if creation failed
  ActData_EXPORT virtual Standard_Integer AddFace (const Standard_Integer idnode1, const Standard_Integer idnode2, const Standard_Integer idnode3, const Standard_Integer idnode4);

  //! create an instance of MeshFace and add it to the mesh
  ActData_EXPORT virtual Standard_Boolean AddFaceWithID (const Standard_Integer idnode1, const Standard_Integer idnode2, const Standard_Integer idnode3, const Standard_Integer idnode4, const Standard_Integer ID);

  //! create an instance of MeshFace and add it to the mesh.
  //! theIDnodes points to an array of nodes IDs containing
  //! theNbNodes Integer values. Returns the id of the
  //! element.  Returns 0 if creation failed
  ActData_EXPORT virtual Standard_Integer AddFace (const Standard_Address theIDnodes, const Standard_Integer theNbNodes);

  //! create an instance of MeshFace and add it to the mesh.
  //! theIDnodes points to an array of nodes IDs containing
  //! theNbNodes Integer values
  ActData_EXPORT virtual Standard_Boolean AddFaceWithID (const Standard_Address theIDnodes, const Standard_Integer theNbNodes, const Standard_Integer ID);

  //! create an instance of MeshElement as a clone of
  //! theElem and add it to the mesh. Returns the id of the
  //! element.  Returns 0 if creation failed
  ActData_EXPORT virtual Standard_Integer AddElement (const Handle(ActData_Mesh_Element)& theElem);

  //! create an instance of MeshElement as a clone of
  //! theElem and add it to the mesh.
  ActData_EXPORT virtual Standard_Boolean AddElementWithID (const Handle(ActData_Mesh_Element)& theElem, const Standard_Integer ID);

  //! remove the node IDnode in the mesh and in all the
  //! children mesh if it exists, it remains in the parent
  //! mesh if the mesh has no parent, then ID is released.
  //! if OnlyFree is true then the node will be removed only
  //! if it is free.  if DeleteFreeNodes is true then the
  //! nodes becoming free are also removed.
  ActData_EXPORT virtual Standard_Boolean RemoveNode (const Standard_Integer IDnode, const Standard_Boolean OnlyFree = Standard_False, const Standard_Boolean DeleteFreeNodes = Standard_True);

  //! remove the edge defined by idnode1,idnode2 in the mesh
  ActData_EXPORT virtual void RemoveEdge (const Standard_Integer idnode1, const Standard_Integer idnode2);

  //! remove the face defined by idnode1,idnode2,idnode3 in the mesh
  ActData_EXPORT virtual void RemoveFace (const Standard_Integer idnode1, const Standard_Integer idnode2, const Standard_Integer idnode3);

  //! remove the face defined by idnode1,idnode2,idnode3,idnode4 in the mesh
  ActData_EXPORT virtual void RemoveFace (const Standard_Integer idnode1, const Standard_Integer idnode2, const Standard_Integer idnode3, const Standard_Integer idnode4);

  //! remove the mesh element IDelem
  //! Caution : Cannot be used to remove nodes, instead
  //! use method RemoveNode
  ActData_EXPORT virtual void RemoveElement (const Standard_Integer IDelem, const Standard_Boolean removenodes = Standard_False);

  ActData_EXPORT void RemoveElement (const Handle(ActData_Mesh_Element)& elem, const Standard_Boolean removenodes = Standard_False);

  //! Check if this and the other meshes belong to the same mesh tree
  //! (i.e., if they may share the nodes)
  ActData_EXPORT Standard_Boolean IsSameMeshTree (const Handle(ActData_Mesh)& theOtherMesh) const;

  ActData_EXPORT Handle(ActData_Mesh_Node) GetNode (const Standard_Integer rank, const Handle(ActData_Mesh_Element)& ME) const;

  //! return the meshnode corresponding to idnode in the mesh
  ActData_EXPORT Handle(ActData_Mesh_Node) FindNode (const Standard_Integer idnode) const;

  ActData_EXPORT Handle(ActData_Mesh_Element) FindEdge (const Standard_Integer idnode1, const Standard_Integer idnode2) const;

  ActData_EXPORT Handle(ActData_Mesh_Element) FindFace (const Standard_Integer idnode1, const Standard_Integer idnode2, const Standard_Integer idnode3) const;

  ActData_EXPORT Handle(ActData_Mesh_Element) FindFace (const Standard_Integer idnode1, const Standard_Integer idnode2, const Standard_Integer idnode3, const Standard_Integer idnode4) const;

  //! returns the mesh element corresponding to IDelem
  //! or NULL handle if no element found corresponding to IDelem
  ActData_EXPORT Handle(ActData_Mesh_Element) FindElement (const Standard_Integer IDelem) const;

  //! calculate mesh element center of gravity
  //! returns true if center of gravity  was calculated
  ActData_EXPORT Standard_Boolean GetCenterOfGravity (const Handle(ActData_Mesh_Element)& ME, gp_XYZ& CenterOfGravity) const;

  ActData_EXPORT Standard_Boolean Contains (const Handle(ActData_Mesh_Element)& elem) const;

  //! clean the inverse connections and rebuild them
  //! completely. If the mesh has children, the
  //! inverse connections are also rebuilt
  ActData_EXPORT void RebuildAllInverseConnections();

  //! clears the inverse connections
  ActData_EXPORT void RemoveAllInverseConnections();

  //! query if the inverse connections are built.
  //! Use this method only in specific cases when you really need
  //! to know in order to choose the correct algorithmic strategy.
  //! Generally it is OK to call RebuildAllInverseConnections in
  //! a slightest doubt.
    Standard_Boolean HasInverseConnections() const;

    Standard_Integer NbNodes() const;

    Standard_Integer NbEdges() const;

    Standard_Integer NbFaces() const;

  ActData_EXPORT void DumpNodes (Standard_OStream& aStream) const;
  
  ActData_EXPORT void DumpEdges (Standard_OStream& aStream) const;
  
  ActData_EXPORT void DumpFaces (Standard_OStream& aStream) const;
  
  ActData_EXPORT void DebugStats (Standard_OStream& aStream) const;
  
  ActData_EXPORT Handle(ActData_Mesh_Element) GetElementFromTree (const Standard_Integer anID, const Standard_Boolean isElement) const;
  
  ActData_EXPORT Handle(ActData_Mesh_Element) CreateEdge (const Standard_Integer ID, const Standard_Integer idnode1, const Standard_Integer idnode2) const;
  
  ActData_EXPORT Handle(ActData_Mesh_Element) CreateFace (const Standard_Integer ID, const Standard_Integer idnode1, const Standard_Integer idnode2, const Standard_Integer idnode3) const;
  
  ActData_EXPORT Handle(ActData_Mesh_Element) CreateFace (const Standard_Integer ID, const Standard_Integer idnode1, const Standard_Integer idnode2, const Standard_Integer idnode3, const Standard_Integer idnode4) const;

friend class ActData_Mesh_ElementsIterator;




protected:

  //! add a node in the mesh, the node must have a valid ID (obtained
  //! by the request to NodeIDFactory).
  //! if the mesh has parent, the node is also added to the parent.
  //! returns False if the node is invalid ( null handle)
  ActData_EXPORT Standard_Boolean AddNode (const Handle(ActData_Mesh_Element)& node);
  
  ActData_EXPORT Handle(ActData_Mesh_Node) FindNode (const Handle(ActData_Mesh_Element)& node) const;
  
  ActData_EXPORT Handle(ActData_Mesh_Element) FindEdge (const Handle(ActData_Mesh_Element)& edge) const;
  
  ActData_EXPORT Handle(ActData_Mesh_Element) FindFace (const Handle(ActData_Mesh_Element)& face) const;
  
  ActData_EXPORT void RemoveInverseElement (const Handle(ActData_Mesh_Element)& node, const Handle(ActData_Mesh_Element)& parent) const;
  
  //! adds the inverse element
  ActData_EXPORT void AddInverseElement (const Handle(ActData_Mesh_Element)& ME) const;
  
  ActData_EXPORT Standard_Boolean RemoveNode (const Handle(ActData_Mesh_Element)& node);
  
  ActData_EXPORT void RemoveEdge (const Handle(ActData_Mesh_Element)& edge);
  
  ActData_EXPORT void RemoveFace (const Handle(ActData_Mesh_Element)& face);
  
  ActData_EXPORT Handle(ActData_Mesh_Element) GetNode (const Standard_Integer ID) const;
  
  //! removes the elements built of the node ME.  If
  //! DeleteNodes is true then the nodes becoming free are
  //! removed also
  ActData_EXPORT void RemoveAncestors (const Handle(ActData_Mesh_Element)& ME, const Standard_Boolean DeleteFreeNodes = Standard_False);

  Handle(ActData_Mesh_IDFactory) myNodeIDFactory;
  Handle(ActData_Mesh_IDFactory) myElementIDFactory;


private:

  void FreeNode (const Handle(ActData_Mesh_Element)& node);

private:

  TColStd_PackedMapOfInteger    myNodes;
  ActData_Mesh_MapOfMeshOrientedElement myEdges;
  ActData_Mesh_MapOfMeshOrientedElement myFaces;
  Standard_Boolean              myHasInverse;

};


//=======================================================================
//function : NbNodes
//purpose  : 
//=======================================================================

inline Standard_Integer ActData_Mesh::NbNodes() const
{
  return myNodes.Extent();
}

//=======================================================================
//function : NbEdges
//purpose  : 
//=======================================================================

inline Standard_Integer ActData_Mesh::NbEdges() const
{
  return myEdges.Extent();
}

//=======================================================================
//function : NbFaces
//purpose  : 
//=======================================================================

inline Standard_Integer ActData_Mesh::NbFaces() const
{
  return myFaces.Extent();
}


//=======================================================================
//function : Destruct
//purpose  : 
//=======================================================================

inline void ActData_Mesh::Destruct ()
{
  Clear (Standard_False);
}

//=======================================================================
//function : HasInverseConnections
//purpose  :
//=======================================================================

inline Standard_Boolean ActData_Mesh::HasInverseConnections () const
{
  return myHasInverse;
}

typedef ActData_Mesh* ActData_Mesh_Ptr;

//-----------------------------------------------------------------------------

//! \ingroup AD_DF
//!
//! Convenience type definition for sequence.
typedef NCollection_Sequence<Handle(ActData_Mesh)> ActData_Mesh_SequenceOfMesh;

//! \ingroup AD_DF
//!
//! Convenience type definition for list.
typedef NCollection_List<Handle(ActData_Mesh)> ActData_Mesh_ListOfMesh;

#endif
