//-----------------------------------------------------------------------------
// Created on: 24 May 2024
//-----------------------------------------------------------------------------
// Copyright (c) 2024-present, Quaoar Studio LLC
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

#ifndef asiAlgo_FeatureAttrOuterWire_h
#define asiAlgo_FeatureAttrOuterWire_h

// asiAlgo includes
#include <asiAlgo.h>

// asiAlgo includes
#include <asiAlgo_FeatureAttrFace.h>

// OpenCascade includes
#include <TopoDS_Wire.hxx>

//-----------------------------------------------------------------------------

//! \ingroup ASI_AFR
//!
//! AAG attribute to store outer wire of a face.
class asiAlgo_FeatureAttrOuterWire : public asiAlgo_FeatureAttr
{
  // OCCT RTTI
  DEFINE_STANDARD_RTTI_INLINE(asiAlgo_FeatureAttrOuterWire, asiAlgo_FeatureAttr)

public:

  //! Ctor.
  asiAlgo_FeatureAttrOuterWire()
  //
  : asiAlgo_FeatureAttr()
  {}

  //! Complete ctor.
  asiAlgo_FeatureAttrOuterWire(const TopoDS_Wire& _wire)
  : asiAlgo_FeatureAttr (),
    wire                (_wire)
  {}

  //! \return static GUID associated with this type of attribute.
  static const Standard_GUID& GUID()
  {
    static Standard_GUID guid("8DD0E0C0-481E-4370-A319-6A75D87FBF2E");
    return guid;
  }

  //! \return GUID associated with this type of attribute.
  virtual const Standard_GUID& GetGUID() const override
  {
    return GUID();
  }

  //! \return human-friendly name of the attribute.
  virtual const char* GetName() const override
  {
    return "Outer wire";
  }

public:

  TopoDS_Wire wire;

};

#endif
