//-----------------------------------------------------------------------------
// Created on: March 2012
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

#ifndef ActAPI_INode_HeaderFile
#define ActAPI_INode_HeaderFile

// Active Data (API) includes
#include <ActAPI_IParameter.h>

// OCCT includes
#include <Standard_Type.hxx>
#include <NCollection_List.hxx>
#include <TCollection_AsciiString.hxx>
#include <TCollection_ExtendedString.hxx>

//! \ingroup AD_DF
//!
//! ID in form of CAF entry, e.g. "0:1:1".
typedef TCollection_AsciiString ActAPI_NodeId;

//! \ingroup AD_DF
//!
//! Short-cuts for collection of Node IDs.
typedef NCollection_Sequence<ActAPI_NodeId>   ActAPI_NodeIdList;
typedef NCollection_Shared<ActAPI_NodeIdList> ActAPI_HNodeIdList;

//! \ingroup AD_DF
//!
//! Short-cuts for collection of Node IDs.
typedef NCollection_IndexedMap<ActAPI_NodeId> ActAPI_NodeIdMap;
typedef NCollection_Shared<ActAPI_NodeIdMap>  ActAPI_HNodeIdMap;

//-----------------------------------------------------------------------------

//! \ingroup AD_DF
//!
//! Short-cuts for collection of Nodes.
typedef NCollection_Sequence<Handle(ActAPI_INode)> ActAPI_NodeList;
typedef NCollection_Shared<ActAPI_NodeList>        ActAPI_HNodeList;

//! \ingroup AD_DF
//!
//! Shortcuts for map of Nodes.
typedef NCollection_Map<Handle(ActAPI_INode), ActAPI_IDataCursor::Hasher> ActAPI_NodeMap;
typedef NCollection_Shared<ActAPI_NodeMap>                                ActAPI_HNodeMap;

//-----------------------------------------------------------------------------

//! \ingroup AD_DF
//!
//! Iterator for Nodal Parameters.
class ActAPI_IParamIterator : public Standard_Transient
{
public:

  // OCCT RTTI
  DEFINE_STANDARD_RTTI_INLINE(ActAPI_IParamIterator, Standard_Transient)

public:

  ActData_EXPORT virtual
    ~ActAPI_IParamIterator();

public:

  virtual void
    Init(const Handle(ActAPI_INode)& theNode) = 0;

  virtual Standard_Boolean
    More() const = 0;

  virtual void
    Next() = 0;

  virtual Standard_Integer
    Key() const = 0;

  virtual const Handle(ActAPI_IUserParameter)&
    Value() const = 0;
};

//-----------------------------------------------------------------------------

//! \ingroup AD_DF
//!
//! Iterator for child Nodes.
class ActAPI_IChildIterator : public Standard_Transient
{
public:

  // OCCT RTTI
  DEFINE_STANDARD_RTTI_INLINE(ActAPI_IChildIterator, Standard_Transient)

public:

  ActData_EXPORT virtual ~ActAPI_IChildIterator();

public:

  virtual void
    Init(const Handle(ActAPI_INode)& theNode,
         const Standard_Boolean isAllLevels = Standard_False) = 0;

  virtual Standard_Boolean
    More() const = 0;

  virtual void
    Next() = 0;

  virtual Handle(ActAPI_INode)
    Value() const = 0;

  virtual TDF_Label
    ValueLabel() const = 0;
};

//-----------------------------------------------------------------------------

//! \ingroup AD_DF
//!
//! Interface for Active Data Nodes. Active Data uses OCCT OCAF component
//! for persistence mechanism along with widely spread useful services, e.g.
//! Undo/Redo, transactional modifications, etc. OCAF data lives in a so called
//! "Document" which normally has sophisticated internal structure which is almost
//! unusable as-is due to its high complexity and lack of human-friendly
//! abstractions. That is why Data Models based on OCAF are normally designed
//! to provide less granularity expressing the domain-specific structure
//! by high-level abstract Data Object. Active Data provides an
//! interface-based solution for designing arbitrary Data Models. Here, we
//! use two main concepts:
//!
//! 1. Raw data or CAF Document. These are the data chunks which are actually
//!    mapped onto OCAF structures and constitute the persistent model of
//!    data. CAF Document stores data in its native hierarchical form
//!    which needs some additional interpretation from application side in
//!    order to be mapped onto real meaningful domain-specific entities. You
//!    can think of CAF Document as a labyrinthine data source.
//!
//! 2. Data cursors. These are the Data Nodes playing as windows to the
//!    underlying CAF structures. Normally, if you want to work with some
//!    portion of CAF data, you allocate (by need) the corresponding cursor
//!    object which knows everything about sophisticated CAF structure forming
//!    a particular entity. Each cursor can exists in three basic states:
//!
//!    a) DETACHED. It means that the cursor is not currently bound to any
//!       underlying CAF entity. You cannot work with actual data in that case.
//!
//!    b) BAD-FORMED. It means that the cursor is attached to the CAF document
//!       but the underlying CAF structure does not meet the cursor's
//!       expectations. This could happen if you settle down your cursor into
//!       bad place (which does not correspond to the hierarchical root of
//!       the interesting domain entity) or into not valid (or not prepared
//!       yet) data.
//!
//!    c) WELL-FORMED. It means that your cursor is successfully charged with
//!       raw data and you can access it (observe, modify) in transactional
//!       scope.
//!  
//!    Notice that Data Nodes (cursor objects of Active Data) have
//!    their internal structure which is chosen to keep the best balance
//!    between the complexity of the underlying CAF Document and complexity
//!    of the cursor itself. ACT Data Nodes are designed to keep underlying
//!    Parameters (lower level cursors to primitive data types) in a way
//!    which is most convenient for data manipulation. See actual structure
//!    of a Data Node in its basic implementation class.
class ActAPI_INode : public ActAPI_IDataCursor
{
public:

  // OCCT RTTI
  DEFINE_STANDARD_RTTI_INLINE(ActAPI_INode, ActAPI_IDataCursor)

public:

  ActData_EXPORT virtual
    ~ActAPI_INode();

// Interface for common Parameters:
public:

  virtual Handle(ActAPI_IParamIterator)
    GetParamIterator() const = 0;

  virtual Handle(ActAPI_HIndexedParameterMap)
    Parameters() const = 0;

  virtual Handle(ActAPI_IUserParameter)
    Parameter(const Standard_Integer theId) const = 0;

  virtual void
    InitParameter(const Standard_Integer theId,
                  const TCollection_ExtendedString& theName,
                  const TCollection_AsciiString& theSemanticId = TCollection_AsciiString(),
                  const Standard_Integer theUFlags = 0x000000,
                  const Standard_Boolean isSilent = Standard_False) = 0;

// Convenient accessors for some configurable internal properties:
public:

  virtual TCollection_ExtendedString
    GetName() = 0;

  virtual void
    SetName(const TCollection_ExtendedString& theName) = 0;

  virtual TCollection_AsciiString
    GetTypeName() = 0;

  virtual Standard_Integer
    GetUserFlags() = 0;

  virtual Standard_Boolean
    HasUserFlags(const Standard_Integer theUFlags) = 0;

  virtual void
    SetUserFlags(const Standard_Integer theUFlags) = 0;

  virtual void
    AddUserFlags(const Standard_Integer theUFlags) = 0;

  virtual void
    RemoveUserFlags(const Standard_Integer theUFlags) = 0;

// Alternative hierarchy of Nodes:
public:

  virtual Handle(ActAPI_IChildIterator)
    GetChildIterator(const Standard_Boolean isAllLevels = Standard_False) const = 0;

  virtual Handle(ActAPI_INode)
    GetChildNode(const Standard_Integer oneBased_idx) const = 0;

  virtual int
    GetChildren(Handle(ActAPI_HNodeList)& theChildren) const = 0;

  virtual void
    AddChildNode(const Handle(ActAPI_INode)& theNode) = 0;

  virtual Standard_Boolean
    RemoveChildNode(const Handle(ActAPI_INode)& theNode) = 0;

  virtual Handle(ActAPI_INode)
    GetParentNode() const = 0;

// Embedded Tree Function mechanism:
public:

  virtual void
    ConnectTreeFunction(const Standard_Integer theId,
                        const Standard_GUID& theGUID,
                        const Handle(ActAPI_HParameterList)& theArgsIN,
                        const Handle(ActAPI_HParameterList)& theArgsOUT) = 0;

  virtual Standard_Boolean
    HasConnectedTreeFunction(const Standard_Integer theId) = 0;

  virtual void
    DisconnectTreeFunction(const Standard_Integer theId) = 0;

// Variables mechanism:
public:

  virtual void
    ConnectEvaluator(const Standard_Integer theId,
                     const Handle(ActAPI_HParameterList)& theVarsIN = nullptr) = 0;

  virtual Standard_Boolean
    HasConnectedEvaluator(const Standard_Integer theId) = 0;

  virtual Handle(ActAPI_IUserParameter)
    Evaluator(const Standard_Integer theId) = 0;

  virtual Standard_Boolean
    IsEvaluable(const Standard_Integer theId) = 0;

  virtual void
    DisconnectEvaluator(const Standard_Integer theId) = 0;

// Plain references:
public:

  virtual void
    ConnectReference(const Standard_Integer theId,
                     const Handle(ActAPI_IDataCursor)& theTarget) = 0;

  virtual Standard_Boolean
    HasConnectedReference(const Standard_Integer theId) = 0;

  virtual void
    DisconnectReference(const Standard_Integer theId) = 0;

// Multiple references:
public:

  virtual void
    ConnectReferenceToList(const Standard_Integer theId,
                           const Handle(ActAPI_IDataCursor)& theTarget,
                           const Standard_Integer theAfterIndex = 0) = 0;

  virtual Standard_Boolean
    HasConnectedReferenceList(const Standard_Integer theId) = 0;

  virtual void
    DisconnectReferenceList(const Standard_Integer theId) = 0;

  virtual Standard_Boolean
    DisconnectReferenceFromList(const Standard_Integer theId,
                                const Standard_Integer theIndex) = 0;

// Back-references:
public:

  virtual Handle(ActAPI_HParameterList)
    GetInputReaders() = 0;

  virtual Handle(ActAPI_HParameterList)
    GetOutputWriters() = 0;

  virtual Handle(ActAPI_HParameterList)
    GetReferrers() = 0;

};

#endif
