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

#ifndef ActAPI_IUserParameter_HeaderFile
#define ActAPI_IUserParameter_HeaderFile

// Active Data (API) includes
#include <ActAPI_IDataCursor.h>

// OCCT includes
#include <NCollection_SparseArray.hxx>

// Standard includes
#include <map>

// Active Data (API) forward declarations
class ActAPI_INode;

//! \ingroup AD_DF
//!
//! ID in form of CAF entry, e.g. "0:1:1".
typedef TCollection_AsciiString ActAPI_ParameterId;

//! \ingroup AD_DF
//!
//! Short-cuts for collection of Parameter IDs.
typedef NCollection_Sequence<ActAPI_ParameterId>   ActAPI_ParameterIdList;
typedef NCollection_Shared<ActAPI_ParameterIdList> ActAPI_HParameterIdList;

//! \ingroup AD_DF
//!
//! Short-cuts for collection of Parameter IDs.
typedef NCollection_IndexedMap<ActAPI_ParameterId> ActAPI_ParameterIdMap;
typedef NCollection_Shared<ActAPI_ParameterIdMap>  ActAPI_HParameterIdMap;

//-----------------------------------------------------------------------------
// Common enumerations
//-----------------------------------------------------------------------------

//! \ingroup AD_DF
//!
//! Enumeration for all Parameter types available in Active Data.
//! The proposed "palette" of basic types seems to suit well many CAD/CAM/CAE
//! applications whose data models are based on STANDARD OCAF. However,
//! there are some reasons not to limit the client code with the standard
//! types. Here they are:
//!
//! 1. Too much labels in OCAF is a bad practice. If you have a complex data
//!    type, you'd better derive a custom attribute for it. Otherwise, you
//!    waste memory on labels, and labels, and labels...
//!
//! 2. Some data structures neither easy, nor reasonable to express in terms
//!    of primitive attributes. Moreover, doing so allow Active Data to
//!    affect into your data design, which is hardly acceptable.
//!
//! Therefore, Active Data does not forbid extension. Check user's guide to
//! see how to inject your Parameter types into the framework.
enum ActAPI_ParameterType
{
  Parameter_UNDEFINED     = 0,  //!< NONE.
  //
  Parameter_META          = 1,  //!< META data.
  //
  Parameter_Int           = 2,  //!< Integer.
  Parameter_Real          = 3,  //!< Real.
  Parameter_Bool          = 4,  //!< Boolean.
  Parameter_Shape         = 5,  //!< OpenCascade's CAD model.
  Parameter_Mesh          = 6,  //!< Surface mesh (no link to CAD).
  Parameter_AsciiString   = 7,  //!< ASCII string.
  Parameter_Name          = 8,  //!< Unicode string.
  Parameter_Selection     = 9,  //!< Efficient integer map (bitmask).
  Parameter_TimeStamp     = 10, //!< Timestamp.
  Parameter_IntArray      = 11, //!< Array of integer values.
  Parameter_RealArray     = 12, //!< Array of real values.
  Parameter_StringArray   = 13, //!< Array of string values.
  Parameter_ComplexArray  = 14, //!< Array of complex numbers.
  Parameter_BoolArray     = 15, //!< Array of Boolean values.
  Parameter_Group         = 16, //!< Structural Parameter for linear grouping.
  Parameter_TreeFunction  = 17, //!< Tree Function.
  Parameter_TreeNode      = 18, //!< Tree Node.
  Parameter_Reference     = 20, //!< Reference to another Parameter.
  Parameter_ReferenceList = 21, //!< Multiple reference to other Parameters.
  Parameter_Triangulation = 22, //!< Surface triangulation (no link to CAD).
  //
  Parameter_LASTFREE            //! Last not occupied ID of Parameter type.
                                //! Other IDs will be Parameter_LASTFREE + ...
};

//! \ingroup AD_DF
//!
//! Modification marker for Nodal Parameters. When any Parameter is being
//! updated, user normally specifies the corresponding modification type in
//! order to inform the Tree Function mechanism about this modification.
enum ActAPI_ModificationType
{
  MT_Touched,  //!< Modified by user directly or by some middle layer.
  MT_Impacted, //!< Modified by Tree Function.
  MT_Silent    //!< Modified without synchronization (use with care).
};

//-----------------------------------------------------------------------------
// Basic interface for Parameters
//-----------------------------------------------------------------------------

//! \ingroup AD_DF
//!
//! Base interface for Nodal Parameter.
class ActAPI_IUserParameter : public ActAPI_IDataCursor
{
public:

  // OCCT RTTI
  DEFINE_STANDARD_RTTI_INLINE(ActAPI_IUserParameter, ActAPI_IDataCursor)

public:

  ActData_EXPORT virtual
    ~ActAPI_IUserParameter();

// Persistent properties:
public:
  
  virtual Standard_Integer
    GetParamType() = 0;

  virtual void
    SetEvalString(const TCollection_AsciiString& theEvalString,
                  const ActAPI_ModificationType theModType = MT_Touched) = 0;

  virtual TCollection_AsciiString
    GetEvalString() = 0;

  virtual void
    SetName(const TCollection_ExtendedString& theString,
            const ActAPI_ModificationType theModType = MT_Silent) = 0;

  virtual TCollection_ExtendedString
    GetName() = 0;

  virtual Handle(ActAPI_INode)
    GetNode() = 0;

  virtual ActAPI_DataObjectId
    GetNodeId() = 0;

  virtual void
    SetUserFlags(const Standard_Integer theUFlags,
                 const ActAPI_ModificationType theModType = MT_Silent) = 0;

  virtual Standard_Boolean
    HasUserFlags(const Standard_Integer theUFlags) = 0;

  virtual void
    AddUserFlags(const Standard_Integer theUFlags,
                 const ActAPI_ModificationType theModType = MT_Silent) = 0;

  virtual void
    RemoveUserFlags(const Standard_Integer theUFlags,
                    const ActAPI_ModificationType theModType = MT_Silent) = 0;

  virtual Standard_Integer
    GetUserFlags() = 0;

  virtual void
    SetSemanticId(const TCollection_AsciiString& theId,
                  const ActAPI_ModificationType theModType = MT_Silent) = 0;

  virtual TCollection_AsciiString
    GetSemanticId() = 0;

  virtual void
    SetValidity(const Standard_Boolean isValid,
                const ActAPI_ModificationType theModType = MT_Silent) = 0;

  virtual void
    SetPending(const Standard_Boolean isPending,
               const ActAPI_ModificationType theModType = MT_Silent) = 0;

  virtual void
    SetModified() = 0;

};

//! \ingroup AD_DF
//!
//! Shortcuts for map of Parameters.
typedef NCollection_Map<Handle(ActAPI_IUserParameter), ActAPI_IDataCursor::Hasher> ActAPI_ParameterMap;
typedef NCollection_Shared<ActAPI_ParameterMap>                                    ActAPI_HParameterMap;

//! \ingroup AD_DF
//!
//! Shortcuts for list of Parameters.
typedef NCollection_Sequence<Handle(ActAPI_IUserParameter)> ActAPI_ParameterList;
typedef NCollection_Shared<ActAPI_ParameterList>            ActAPI_HParameterList;

//! \ingroup AD_DF
//!
//! Shortcuts for list of Parameter types. We use Integer instead of
//! actual items from ActAPI_ParameterType enumeration in order to allow
//! merging types and their consequent masking.
typedef NCollection_Sequence<Standard_Integer>       ActAPI_ParameterTypeList;
typedef NCollection_Shared<ActAPI_ParameterTypeList> ActAPI_HParameterTypeList;

//! \ingroup AD_DF
//!
//! Type definition for sparse collection of Parameters.
typedef std::map<int, Handle(ActAPI_IUserParameter)>   ActAPI_IndexedParameterMap;
typedef NCollection_Shared<ActAPI_IndexedParameterMap> ActAPI_HIndexedParameterMap;

//-----------------------------------------------------------------------------
// Parameter streaming
//-----------------------------------------------------------------------------

//! \ingroup AD_DF
//!
//! Class providing a convenient way for assembling Parameter lists.
class ActAPI_ParameterStream
{
public:

  Handle(ActAPI_HParameterList) List; //!< Actual list.

public:

  //! Conversion operator.
  operator Handle(ActAPI_HParameterList)()
  {
    return List;
  }

  //! Pushes the passed Parameter to the internal list.
  //! \param theParam [in] Parameter to append to the internal list.
  //! \return this instance for further streaming.
  ActAPI_ParameterStream& operator<<(const Handle(ActAPI_IUserParameter)& theParam)
  {
    if ( List.IsNull() )
      List = new ActAPI_HParameterList();

    List->Append(theParam);

    return *this;
  }
};

//! Convenient shortcut.
typedef ActAPI_ParameterStream ActParamStream;

//! \ingroup AD_DF
//!
//! Class providing a convenient way for assembling Parameter type lists.
class ActAPI_ParameterTypeStream
{
public:

  Handle(ActAPI_HParameterTypeList) List; //!< Actual list.

public:

  //! Conversion operator.
  operator Handle(ActAPI_HParameterTypeList)()
  {
    return List;
  }

  //! Pushes the passed Parameter type onto the internal list.
  //! \param theParamType [in] Parameter type to append to the internal list.
  //! \return this instance for further streaming.
  ActAPI_ParameterTypeStream& operator<<(const Standard_Integer theParamType)
  {
    if ( List.IsNull() )
      List = new ActAPI_HParameterTypeList();

    List->Append(theParamType);

    return *this;
  }

};

//-----------------------------------------------------------------------------
// Parameter along with owning Node
//-----------------------------------------------------------------------------

//! \ingroup AD_DF
//!
//! Parameter belonging to Data Node.
struct ActAPI_NodalParameter
{
  Handle(ActAPI_IUserParameter) Parameter;  //!< Parameter instance.
  Standard_Integer              RelativeId; //!< ID of the Parameter in Nodal scope.
  Standard_Boolean              IsInternal; //!< True for internal Nodal scope.

  //! Switches structure properties to their initial state.
  void Reset()
  {
    Parameter.Nullify();
    RelativeId = -1;
    IsInternal = Standard_False;
  }

  //! Default constructor.
  ActAPI_NodalParameter()
  {
    this->Reset();
  }

  //! Constructor accepting a complete set of arguments to initialize the
  //! Nodal Parameter structure.
  //! \param theParam [in] Parameter instance.
  //! \param theId [in] relative ID of the Parameter in Nodal scope.
  //! \param isInternal [in] indicates whether the passed Parameter is
  //!        internal for the owning Node (true) or user-defined (false).
  ActAPI_NodalParameter(const Handle(ActAPI_IUserParameter)& theParam,
                        const Standard_Integer               theId,
                        const Standard_Boolean               isInternal)
  : Parameter(theParam),
    RelativeId(theId),
    IsInternal(isInternal)
  {}
};

//! \ingroup AD_DF
//!
//! Type definition for ordered collection of Parameters with bound
//! information of their parent Data Nodes.
typedef NCollection_Sequence<ActAPI_NodalParameter>   ActAPI_NodalParameterList;
typedef NCollection_Shared<ActAPI_NodalParameterList> ActAPI_HNodalParameterList;

//-----------------------------------------------------------------------------
// Parameter along with owning Node TYPE
//-----------------------------------------------------------------------------

//! \ingroup AD_DF
//!
//! Relative ID of Parameter along with a particular Nodal type. This
//! information is enough to refer to a given Parameter type in any
//! Data Node of a desired type.
struct ActAPI_ParameterLocator
{
  TCollection_AsciiString NodeType; //!< Node type.
  Standard_Integer        PID;      //!< ID of the Parameter in Nodal scope.

  //! Default constructor.
  ActAPI_ParameterLocator() : NodeType(""), PID(-1)
  {}

  //! Constructor accepting a complete set of arguments to initialize the
  //! structure.
  //! \param theNodeType [in] Node type.
  //! \param thePID [in] relative ID of the Parameter in Nodal scope.
  ActAPI_ParameterLocator(const TCollection_AsciiString& theNodeType,
                          const Standard_Integer         thePID)
  : NodeType(theNodeType),
    PID(thePID)
  {}

  //! Checks whether this Locator is equal to the passed one.
  //! \param theLocator [in] Locator to compare with.
  Standard_Boolean IsEqual(const ActAPI_ParameterLocator& theLocator) const
  {
    return NodeType.IsEqual(theLocator.NodeType) && (PID == theLocator.PID);
  }

};

//! \ingroup AD_DF
//!
//! Type definition for ordered collection of Parameters with bound
//! information of their parent Data Nodes.
typedef NCollection_Sequence<ActAPI_ParameterLocator>   ActAPI_ParameterLocatorList;
typedef NCollection_Shared<ActAPI_ParameterLocatorList> ActAPI_HParameterLocatorList;

//! \ingroup AD_DF
//!
//! Class providing a convenient way for assembling Parameter Locator
//! structures.
class ActAPI_ParameterLocatorStream
{
public:

  Handle(ActAPI_HParameterLocatorList) List; //!< Actual list.

public:

  //! Default constructor.
  ActAPI_ParameterLocatorStream()
  {
    List = new ActAPI_HParameterLocatorList();
  }

  //! Copy constructor. Performs SHALLOW copying.
  //! \param S [in] stream to copy.
  ActAPI_ParameterLocatorStream(const ActAPI_ParameterLocatorStream& S)
  {
    List = S.List;
  }

  //! Conversion operator.
  operator Handle(ActAPI_HParameterLocatorList)()
  {
    return List;
  }

  //! Pushes the passed Parameter Locator structure onto the internal list.
  //! \param theParamLoc [in] Parameter Locator to append to the internal list.
  //! \return this instance for further streaming.
  ActAPI_ParameterLocatorStream& operator<<(const ActAPI_ParameterLocator& theParamLoc)
  {
    List->Append(theParamLoc);

    return *this;
  }
};

//-----------------------------------------------------------------------------
// Extended Parameter Locator to represent unique Parameter ID
//-----------------------------------------------------------------------------

//! \ingroup AD_DF
//!
//! This structure represents global ID (GID) of a Parameter composed of
//! its local ID and ID of the parent Node.
struct ActAPI_ParameterGID
{
  ActAPI_DataObjectId NID; //!< ID of the owning Node.
  Standard_Integer    PID; //!< Local ID of Parameter.

  //! Default constructor.
  ActAPI_ParameterGID() : NID( ActAPI_DataObjectId() ), PID(-1)
  {}

  //! Constructor accepting a complete set of arguments to initialize the
  //! structure.
  //! \param theNID [in] ID of the owning Node.
  //! \param thePID [in] relative ID of the Parameter in Nodal scope.
  ActAPI_ParameterGID(const ActAPI_DataObjectId& theNID,
                      const Standard_Integer     thePID = -1)
  : NID(theNID),
    PID(thePID)
  {}

  //! Returns true if GID is not initialized, false -- otherwise.
  //! \return true/false.
  Standard_Boolean IsNull() const
  {
    return NID.IsEmpty() || PID == -1;
  }

  //! Hasher tool for data maps.
  struct Hasher
  {
    //! Calculates hash code for Parameter GID.
    //! \param theNbBuckets [in] number of buckets.
    //! \return hash code.
    static Standard_Integer HashCode(const ActAPI_ParameterGID& theGID,
                                     const Standard_Integer     theNbBuckets = 100)
    {
      TCollection_AsciiString
        aUniqueName = TCollection_AsciiString(theGID.NID).Cat("_").Cat(theGID.PID);

      return ::HashCode(aUniqueName, theNbBuckets);
    }

    //! Checks whether two GIDs are equal.
    //! \param theGID1 [in] first GID to compare.
    //! \param theGID2 [in] second GID to compare.
    //! \return true/false.
    static Standard_Boolean IsEqual(const ActAPI_ParameterGID& theGID1,
                                    const ActAPI_ParameterGID& theGID2)
    {
      if ( theGID1.PID == -1 || theGID2.PID == -1 )
        return Standard_False;

      return theGID1.NID.IsEqual(theGID2.NID) && (theGID1.PID == theGID2.PID);
    }
  };

};

//! \ingroup AD_DF
//!
//! Type definition for ordered collection of Parameters with bound
//! information of their parent Data Nodes.
typedef NCollection_Sequence<ActAPI_ParameterGID>   ActAPI_ParameterGIDList;
typedef NCollection_Shared<ActAPI_ParameterGIDList> ActAPI_HParameterGIDList;

#endif
