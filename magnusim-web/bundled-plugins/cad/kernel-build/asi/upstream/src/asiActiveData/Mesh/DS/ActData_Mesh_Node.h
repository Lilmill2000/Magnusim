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

#ifndef ActData_Mesh_Node_HeaderFile
#define ActData_Mesh_Node_HeaderFile

// Mesh includes
#include <ActData_Mesh_Element.h>
#include <ActData_Mesh_Position.h>

DEFINE_STANDARD_HANDLE(ActData_Mesh_Node, ActData_Mesh_Element)

class ActData_Mesh_Node : public ActData_Mesh_Element
{
public:

  // OCCT RTTI
  DEFINE_STANDARD_RTTI_INLINE(ActData_Mesh_Node, ActData_Mesh_Element)

public:

  ActData_Mesh_Node() : ActData_Mesh_Element (-1,1) {}

public:

  ActData_EXPORT ActData_Mesh_Node(const Standard_Integer ID, const Standard_Real x, const Standard_Real y, const Standard_Real z);

  ActData_EXPORT void Print (Standard_OStream& OS) const Standard_OVERRIDE;

    Standard_Integer GetKey() const Standard_OVERRIDE;

    Standard_Real X() const;

    Standard_Real Y() const;

    Standard_Real Z() const;

    const gp_Pnt& Pnt() const;

  //! Change the node location. If the last parameter is passed True,
  //! then the normals are cleared in the Node and in all its
  //! inverse elements.
  ActData_EXPORT void SetPnt (const gp_Pnt& P, const Standard_Boolean isClearNormals = Standard_False);

    void AddInverseElement (const Handle(ActData_Mesh_Element)& ME) Standard_OVERRIDE;

  ActData_EXPORT void RemoveInverseElement (const Handle(ActData_Mesh_Element)& parent);

    const ActData_Mesh_ListOfElements& InverseElements() const Standard_OVERRIDE;

    void ClearInverseElements() Standard_OVERRIDE;

    void SetPosition (const Handle(ActData_Mesh_Position)& aPos);

    const Handle(ActData_Mesh_Position)& GetPosition() const;

  //! return the mesh element type
    ActData_Mesh_ElementType GetType() const Standard_OVERRIDE;

  //! creates a copy of me
    virtual Handle(ActData_Mesh_Element) Copy (const Standard_Integer theID) const Standard_OVERRIDE;

public:

    inline Standard_Boolean operator>(const ActData_Mesh_Node& N) const
    {
      return this->GetID() > N.GetID();
    }

    inline Standard_Boolean operator==(const ActData_Mesh_Node& N) const
    {
      return this->GetID() == N.GetID();
    }

private:

  gp_Pnt                myPnt;
  ActData_Mesh_ListOfElements   myInverseElements;
  Handle(ActData_Mesh_Position) myPosition;

};


//=======================================================================
//function : GetKey
//purpose  : 
//=======================================================================

inline Standard_Integer ActData_Mesh_Node::GetKey() const
{
  return myID;
}

//=======================================================================
//function : X
//purpose  : 
//           
//=======================================================================

inline Standard_Real ActData_Mesh_Node::X() const
{
  return myPnt.X();
}

//=======================================================================
//function : Y
//purpose  : 
//           
//=======================================================================

inline Standard_Real ActData_Mesh_Node::Y() const
{
  return myPnt.Y();
}

//=======================================================================
//function : Z
//purpose  : 
//=======================================================================

inline Standard_Real ActData_Mesh_Node::Z() const
{
  return myPnt.Z();
}

//=======================================================================
//function : Pnt
//purpose  : 
//           
//=======================================================================

inline const gp_Pnt& ActData_Mesh_Node::Pnt() const
{
  return myPnt;
}

//=======================================================================
//function : AddInverseElement
//purpose  : 
//=======================================================================

inline void ActData_Mesh_Node::AddInverseElement(const Handle(ActData_Mesh_Element)& ME)
{
  myInverseElements.Append(ME);
}

//=======================================================================
//function : InverseElements
//purpose  : 
//=======================================================================

inline const ActData_Mesh_ListOfElements& ActData_Mesh_Node::InverseElements() const
{
  return myInverseElements;
}

//=======================================================================
//function : ClearInverseElements
//purpose  : 
//=======================================================================

inline void ActData_Mesh_Node::ClearInverseElements()
{
  myInverseElements.Clear();
}

//=======================================================================
//function : SetPosition
//purpose  : 
//=======================================================================

inline void ActData_Mesh_Node::SetPosition(const Handle(ActData_Mesh_Position)& aPos)
{
  myPosition = aPos;
}

//=======================================================================
//function : GetPosition
//purpose  : 
//=======================================================================

inline const Handle(ActData_Mesh_Position)& ActData_Mesh_Node::GetPosition() const
{
  return myPosition;
}

//=======================================================================
//function : GetType
//purpose  :
//=======================================================================

inline ActData_Mesh_ElementType ActData_Mesh_Node::GetType() const
{
  return ActData_Mesh_ET_Node;
}

//=======================================================================
//function : Copy
//purpose  : creates a copy of me
//=======================================================================

inline Handle(ActData_Mesh_Element) ActData_Mesh_Node::Copy(const Standard_Integer theID) const
{
  return new ActData_Mesh_Node(theID, myPnt.X(), myPnt.Y(), myPnt.Z());
}

#endif
