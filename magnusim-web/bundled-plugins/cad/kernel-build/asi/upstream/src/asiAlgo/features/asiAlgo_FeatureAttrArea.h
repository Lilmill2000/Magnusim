//-----------------------------------------------------------------------------
// Created on: 01 October 2021
//-----------------------------------------------------------------------------
// Copyright (c) 2021, Julia Slyadneva
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

#pragma once

// asiAlgo includes
#include <asiAlgo_FeatureAttrAdjacency.h>
#include <asiAlgo_FeatureAngleType.h>

//-----------------------------------------------------------------------------

//! \ingroup ASI_AFR
//!
//! Attribute storing information about feature area.
class asiAlgo_FeatureAttrArea : public asiAlgo_FeatureAttr
{
  // OCCT RTTI
  DEFINE_STANDARD_RTTI_INLINE(asiAlgo_FeatureAttrArea, asiAlgo_FeatureAttr)

public:

  //! Creates feature area attribute.
  asiAlgo_FeatureAttrArea()
  //
  : asiAlgo_FeatureAttr(),
    m_fArea (0.)
  {}

  //! \param[in] area  angle in radians.
  asiAlgo_FeatureAttrArea(const double area)
  //
  : asiAlgo_FeatureAttr(),
    m_fArea (area)
  {}

public:

  //! \return static GUID associated with this type of attribute.
  static const Standard_GUID& GUID()
  {
    static Standard_GUID guid("AB797114-E456-476F-B897-D1D9B5CEEB97");
    return guid;
  }

  //! \return GUID associated with this type of attribute.
  virtual const Standard_GUID& GetGUID() const
  {
    return GUID();
  }

  //! \return human-readable name of the attribute.
  virtual const char* GetName() const override
  {
    return "Area";
  }

protected:

  //! Dumps extra props to JSON.
  virtual void dumpJSON(Standard_OStream& out,
                        const int         indent) const
  {
    std::string ws(indent, ' ');
    std::string nl = "\n" + ws;

    out << "," << nl << asiAlgo_Utils::Str::Quoted(asiPropName_Value) << ": "
                     << m_fArea;
  }

public:

  //! \return area value.
  double GetArea() const { return m_fArea; }

  //! Sets the area value.
  void SetArea(const double area) { m_fArea = area; }

protected:

  double m_fArea; //!< Bounded surface area.

};
