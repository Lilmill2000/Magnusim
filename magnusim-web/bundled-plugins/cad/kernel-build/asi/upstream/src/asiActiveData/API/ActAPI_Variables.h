//-----------------------------------------------------------------------------
// Created on: April 2012
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

#ifndef ActAPI_Variables_HeaderFile
#define ActAPI_Variables_HeaderFile

// Active Data (API) includes
#include <ActAPI_Common.h>

// OCCT includes
#include <TCollection_AsciiString.hxx>

// TBB includes
#if defined ActiveData_USE_TBB
#include <tbb/concurrent_vector.h>
#else
#include <vector>
#endif

//-----------------------------------------------------------------------------
// Base class
//-----------------------------------------------------------------------------

DEFINE_STANDARD_HANDLE(ActAPI_VariableBase, Standard_Transient)

//! \ingroup AD_DF
//!
//! Base class for Variables.
class ActAPI_VariableBase : public Standard_Transient
{
public:

  // OCCT RTTI
  DEFINE_STANDARD_RTTI_INLINE(ActAPI_VariableBase, Standard_Transient)

public:

  //! Variable name.
  TCollection_AsciiString Name;

protected:

  //! Default constructor
  ActAPI_VariableBase() : Standard_Transient()
  {}

};

//-----------------------------------------------------------------------------
// Integer
//-----------------------------------------------------------------------------

DEFINE_STANDARD_HANDLE(ActAPI_VariableInt, ActAPI_VariableBase)

//! \ingroup AD_DF
//!
//! Integer variable.
class ActAPI_VariableInt : public ActAPI_VariableBase
{
public:

  // OCCT RTTI
  DEFINE_STANDARD_RTTI_INLINE(ActAPI_VariableInt, ActAPI_VariableBase)

public:

  //! Factory method ensuring allocation of Variable instance in a heap.
  //! \param theName [in] variable name.
  //! \param theValue [in] variable value.
  //! \return variable instance.
  ActData_EXPORT static Handle(ActAPI_VariableInt)
    Instance(const TCollection_AsciiString& theName,
             Standard_Integer         theValue)
  {
    return new ActAPI_VariableInt(theName, theValue);
  }

public:

  //! Variable value.
  Standard_Integer Value;

public:

  //! Default constructor.
  ActAPI_VariableInt() : ActAPI_VariableBase()
  {}

  //! Constructor accepting variable value as an argument. The variable will
  //! have no name (empty name member).
  //! \param theValue [in] variable value.
  ActAPI_VariableInt(const Standard_Integer theValue) : ActAPI_VariableBase()
  {
    Value = theValue;
  }

  //! Constructor accepting the name and the value of the variable.
  //! \param theName [in] variable name.
  //! \param theValue [in] variable value.
  ActAPI_VariableInt(const TCollection_AsciiString& theName,
                     Standard_Integer         theValue) : ActAPI_VariableBase()
  {
    Name = theName;
    Value = theValue;
  }

};

//-----------------------------------------------------------------------------
// Real
//-----------------------------------------------------------------------------

DEFINE_STANDARD_HANDLE(ActAPI_VariableReal, ActAPI_VariableBase)

//! \ingroup AD_DF
//!
//! Real variable.
class ActAPI_VariableReal : public ActAPI_VariableBase
{
public:

  // OCCT RTTI
  DEFINE_STANDARD_RTTI_INLINE(ActAPI_VariableReal, ActAPI_VariableBase)

public:

  //! Factory method ensuring allocation of Variable instance in a heap.
  //! \param theName [in] variable name.
  //! \param theValue [in] variable value.
  //! \return variable instance.
  ActData_EXPORT static Handle(ActAPI_VariableReal)
    Instance(const TCollection_AsciiString& theName,
             const Standard_Real            theValue)
  {
    return new ActAPI_VariableReal(theName, theValue);
  }

public:

  //! Variable value.
  Standard_Real Value;

public:

  //! Default constructor.
  ActAPI_VariableReal() : ActAPI_VariableBase()
  {}

  //! Constructor accepting variable value as an argument. The variable will
  //! have no name (empty name member).
  //! \param theValue [in] variable value.
  ActAPI_VariableReal(const Standard_Real theValue) : ActAPI_VariableBase()
  {
    Value = theValue;
  }

  //! Constructor accepting variable name and value as arguments.
  //! \param theName [in] variable name.
  //! \param theValue [in] variable value.
  ActAPI_VariableReal(const TCollection_AsciiString& theName,
                      const Standard_Real            theValue) : ActAPI_VariableBase()
  {
    Name = theName;
    Value = theValue;
  }

};

//-----------------------------------------------------------------------------
// Real array
//-----------------------------------------------------------------------------

DEFINE_STANDARD_HANDLE(ActAPI_VariableRealArray, ActAPI_VariableBase)

//! \ingroup AD_DF
//!
//! Real array variable.
class ActAPI_VariableRealArray : public ActAPI_VariableBase
{
public:

  // OCCT RTTI
  DEFINE_STANDARD_RTTI_INLINE(ActAPI_VariableRealArray, ActAPI_VariableBase)

public:

  //! Factory method ensuring allocation of Variable instance in a heap.
  //! \param theName [in] variable name.
  //! \param theValue [in] variable value.
  //! \return variable instance.
  ActData_EXPORT static Handle(ActAPI_VariableRealArray)
    Instance(const TCollection_AsciiString& theName,
             const Handle(HRealArray)&      theValue)
  {
    return new ActAPI_VariableRealArray(theName, theValue);
  }

public:

  //! Variable value.
  Handle(HRealArray) Value;

public:

  //! Default constructor.
  ActAPI_VariableRealArray() : ActAPI_VariableBase()
  {}

  //! Constructor accepting variable value as an argument. The variable will
  //! have no name (empty name member).
  //! \param theValue [in] variable value.
  ActAPI_VariableRealArray(const Handle(HRealArray)& theValue) : ActAPI_VariableBase()
  {
    Value = theValue;
  }

  //! Constructor accepting variable name and value as arguments.
  //! \param theName [in] variable name.
  //! \param theValue [in] variable value.
  ActAPI_VariableRealArray(const TCollection_AsciiString& theName,
                           const Handle(HRealArray)&      theValue) : ActAPI_VariableBase()
  {
    Name = theName;
    Value = theValue;
  }

};

//-----------------------------------------------------------------------------
// Boolean
//-----------------------------------------------------------------------------

DEFINE_STANDARD_HANDLE(ActAPI_VariableBool, ActAPI_VariableBase)

//! \ingroup AD_DF
//!
//! Bool variable.
class ActAPI_VariableBool : public ActAPI_VariableBase
{
public:

  // OCCT RTTI
  DEFINE_STANDARD_RTTI_INLINE(ActAPI_VariableBool, ActAPI_VariableBase)

public:

  //! Factory method ensuring allocation of Variable instance in a heap.
  //! \param theName [in] variable name.
  //! \param theValue [in] variable value.
  //! \return variable instance.
  ActData_EXPORT static Handle(ActAPI_VariableBool)
    Instance(const TCollection_AsciiString& theName,
             const Standard_Boolean         theValue)
  {
    return new ActAPI_VariableBool(theName, theValue);
  }

public:

  //! Variable value.
  Standard_Boolean Value;

public:

  //! Default constructor.
  ActAPI_VariableBool() : ActAPI_VariableBase()
  {}

  //! Constructor accepting variable value as an argument. The variable will
  //! have no name (empty name member).
  //! \param theValue [in] variable value.
  ActAPI_VariableBool(const Standard_Boolean theValue) : ActAPI_VariableBase()
  {
    Value = theValue;
  }

  //! Constructor accepting variable name and value as arguments.
  //! \param theName [in] variable name.
  //! \param theValue [in] variable value.
  ActAPI_VariableBool(const TCollection_AsciiString& theName,
                      const Standard_Boolean         theValue) : ActAPI_VariableBase()
  {
    Name = theName;
    Value = theValue;
  }

};

//-----------------------------------------------------------------------------
// String
//-----------------------------------------------------------------------------

DEFINE_STANDARD_HANDLE(ActAPI_VariableString, ActAPI_VariableBase)

//! \ingroup AD_DF
//!
//! String variable.
class ActAPI_VariableString : public ActAPI_VariableBase
{
public:

  // OCCT RTTI
  DEFINE_STANDARD_RTTI_INLINE(ActAPI_VariableString, ActAPI_VariableBase)

public:

  //! Factory method ensuring allocation of Variable instance in a heap.
  //! \param theName [in] variable name.
  //! \param theValue [in] variable value.
  //! \return variable instance.
  ActData_EXPORT static Handle(ActAPI_VariableString)
    Instance(const TCollection_AsciiString& theName,
             const std::string&             theValue)
  {
    return new ActAPI_VariableString(theName, theValue);
  }

public:

  //! Variable value.
  std::string Value;

public:

  //! Default constructor.
  ActAPI_VariableString() : ActAPI_VariableBase()
  {}

  //! Constructor accepting variable value as an argument. The variable will
  //! have no name (empty name member).
  //! \param theValue [in] variable value.
  ActAPI_VariableString(const std::string& theValue) : ActAPI_VariableBase()
  {
    Value = theValue;
  }

  //! Constructor accepting variable name and value as arguments.
  //! \param theName [in] variable name.
  //! \param theValue [in] variable value.
  ActAPI_VariableString(const TCollection_AsciiString& theName,
                        const std::string&             theValue) : ActAPI_VariableBase()
  {
    Name = theName;
    Value = theValue;
  }

};

//-----------------------------------------------------------------------------
// String
//-----------------------------------------------------------------------------

DEFINE_STANDARD_HANDLE(ActAPI_VariableShape, ActAPI_VariableBase)

//! \ingroup AD_DF
//!
//! Variable of CAD shape type.
class ActAPI_VariableShape : public ActAPI_VariableBase
{
public:

  // OCCT RTTI
  DEFINE_STANDARD_RTTI_INLINE(ActAPI_VariableShape, ActAPI_VariableBase)

public:

  //! Factory method ensuring allocation of Variable instance in a heap.
  //! \param theName [in] variable name.
  //! \param theValue [in] variable value.
  //! \return variable instance.
  ActData_EXPORT static Handle(ActAPI_VariableShape)
    Instance(const TCollection_AsciiString& theName,
             const TopoDS_Shape& theValue)
  {
    return new ActAPI_VariableShape(theName, theValue);
  }

public:

  //! Variable value.
  TopoDS_Shape Value;

public:

  //! Default constructor.
  ActAPI_VariableShape() : ActAPI_VariableBase()
  {}

  //! Constructor accepting variable value as an argument. The variable will
  //! have no name (empty name member).
  //! \param theValue [in] variable value.
  ActAPI_VariableShape(const TopoDS_Shape& theValue) : ActAPI_VariableBase()
  {
    Value = theValue;
  }

  //! Constructor accepting variable name and value as arguments.
  //! \param theName [in] variable name.
  //! \param theValue [in] variable value.
  ActAPI_VariableShape(const TCollection_AsciiString& theName,
                       const TopoDS_Shape& theValue) : ActAPI_VariableBase()
  {
    Name = theName;
    Value = theValue;
  }

};

//-----------------------------------------------------------------------------
// Auxiliary
//-----------------------------------------------------------------------------

//! \ingroup AD_DF
//!
//! Collection of variables.
#if defined ActiveData_USE_TBB
typedef tbb::concurrent_vector<Handle(ActAPI_VariableBase)> ActAPI_VariableList;
#else
typedef std::vector<Handle(ActAPI_VariableBase)> ActAPI_VariableList;
#endif

//! \ingroup AD_DF
//!
//! Shared collection of variables (designed for manipulation by Handle).
typedef NCollection_Shared<ActAPI_VariableList> ActAPI_HVariableList;

#endif
