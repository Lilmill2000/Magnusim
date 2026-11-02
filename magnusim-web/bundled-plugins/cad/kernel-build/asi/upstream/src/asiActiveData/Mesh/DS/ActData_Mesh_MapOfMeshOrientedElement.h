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

#ifndef ActData_Mesh_MapOfMeshOrientedElement_HeaderFile
#define ActData_Mesh_MapOfMeshOrientedElement_HeaderFile

// Mesh includes
#include <ActData_Mesh_Element.h>

//! Redefinition/definition  of methods of Map from NCollection
class ActData_Mesh_MapOfMeshOrientedElement  : public ActData_Mesh_MapOfOrientedElements
{
 public:

  DEFINE_STANDARD_ALLOC
  
  //! Creates   a Map with  <NbBuckets> buckets. Without
  //! arguments the map is automatically dimensioned.
  ActData_Mesh_MapOfMeshOrientedElement(const Standard_Integer NbBuckets = 1)
  : ActData_Mesh_MapOfOrientedElements( NbBuckets )
  {}
  
  //! Returns  the Item stored  with the Key  <K> in the Map.
  Standard_EXPORT const Handle(ActData_Mesh_Element)& Find (const Handle(ActData_Mesh_Element)& K) const;
  const Handle(ActData_Mesh_Element)& operator() (const Handle(ActData_Mesh_Element)& K) const
  { return Find(K); }
  
  //! Returns the  Item stored with  the Key  <K> in the
  //! Map. This Item can be   modified with  the  syntax
  //! aMap(K) = newItem;
  Standard_EXPORT Handle(ActData_Mesh_Element)& ChangeFind (const Handle(ActData_Mesh_Element)& K);
  Handle(ActData_Mesh_Element)& operator() (const Handle(ActData_Mesh_Element)& K)
  { return ChangeFind(K); }
  
  //! Returns  the Item stored  with the ID in the Map.
  Standard_EXPORT const Handle(ActData_Mesh_Element)& FindID (const Standard_Integer ID) const;
  const Handle(ActData_Mesh_Element)& operator() (const Standard_Integer ID) const
  { return FindID(ID); }
  
  //! Returns True  if the ID is stored  in the
  //! map <me>.
  Standard_EXPORT Standard_Boolean ContainsID (const Standard_Integer ID) const;
};

#endif
