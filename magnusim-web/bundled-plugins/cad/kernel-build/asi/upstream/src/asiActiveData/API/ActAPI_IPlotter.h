//-----------------------------------------------------------------------------
// Created on: 19 September 2021
//-----------------------------------------------------------------------------
// Copyright (c) 2021-present, Sergey Slyadnev
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

#ifndef ActAPI_IPlotter_HeaderFile
#define ActAPI_IPlotter_HeaderFile

// Active Data (API) includes
#include "ActAPI_Common.h"

// OCCT includes
#include <Quantity_Color.hxx>

// STL includes
#include <vector>

// Forward declarations
class Geom2d_Curve;
class Geom_Curve;
class Geom_Plane;
class Geom_Surface;
class Poly_Triangulation;
class ActData_Mesh;
class ActAPI_INode;

//-----------------------------------------------------------------------------

//! \ingroup AD_DF
//!
//! Wrapper for Quantity_Color which allows undefined colors (we need such
//! for "default color" option in imperative plotter).
class ActAPI_Color : public Quantity_Color
{
public:

  //! Converts integer value to a color.
  //! \param[in] icolor integer color code.
  //! \return converted value
  static ActAPI_Color IntToColor(const int icolor)
  {
    unsigned char uRed   = ( icolor >> 16 ) & 0xFF;
    unsigned char uGreen = ( icolor >>  8 ) & 0xFF;
    unsigned char uBlue  =   icolor         & 0xFF;
    return ActAPI_Color(uRed/255., uGreen/255., uBlue/255., Quantity_TOC_RGB);
  }

  //! Converts RGB color to integer.
  //! \param[in] r red component.
  //! \param[in] g green component.
  //! \param[in] b blue component.
  //! \return converted value.
  static int ColorToInt(unsigned int r, unsigned int g, unsigned int b)
  {
    return r << 16 | g << 8 | b;
  }

  //! Converts RGB color to integer.
  //! \param[in] r red component of the color.
  //! \param[in] g green component of the color.
  //! \param[in] b blue component of the color.
  //! \return converted value.
  static int ColorToInt(const double r, const double g, const double b)
  {
    unsigned char red   = (unsigned char) ( floor(r >= 1.0 ? 255 : r * 256.0) );
    unsigned char green = (unsigned char) ( floor(g >= 1.0 ? 255 : g * 256.0) );
    unsigned char blue  = (unsigned char) ( floor(b >= 1.0 ? 255 : b * 256.0) );
    //
    return red << 16 | green << 8 | blue;
  }

  //! Returns "some color" by a numerical index. Use this function when
  //! you want to somehow colorize entities, no matter which colors are
  //! used.
  static ActAPI_Color ColorByIndex(const int i)
  {
    static ActAPI_Color
      ColorBank[] = { ActAPI_Color(0./255.,   0./255.,   255./255., Quantity_TOC_RGB),   // 0
                      ActAPI_Color(0./255.,   0./255.,   223./255., Quantity_TOC_RGB),   // 1
                      ActAPI_Color(0./255.,   100./255., 248./255., Quantity_TOC_RGB),   // 2
                      ActAPI_Color(0./255.,   155./255., 255./255., Quantity_TOC_RGB),   // 3
                      ActAPI_Color(0./255.,   201./255., 200./255., Quantity_TOC_RGB),   // 4
                      ActAPI_Color(0./255.,   255./255., 206./255., Quantity_TOC_RGB),   // 5
                      ActAPI_Color(0./255.,   147./255., 57./255.,  Quantity_TOC_RGB),   // 6
                      ActAPI_Color(33./255.,  225./255., 28./255.,  Quantity_TOC_RGB),   // 7
                      ActAPI_Color(100./255., 250./255., 37./255.,  Quantity_TOC_RGB),   // 8
                      ActAPI_Color(218./255., 254./255., 0./255.,   Quantity_TOC_RGB),   // 9
                      ActAPI_Color(255./255., 200./255., 0./255.,   Quantity_TOC_RGB),   // 10
                      ActAPI_Color(255./255., 125./255., 0./255.,   Quantity_TOC_RGB),   // 11
                      ActAPI_Color(255./255., 0./255.,   0./255.,   Quantity_TOC_RGB),   // 12
                      ActAPI_Color(255./255., 255./255., 255./255., Quantity_TOC_RGB) }; // 13

    const int num = (int) sizeof(ColorBank)/sizeof(ActAPI_Color);
    ActAPI_Color res = ColorBank[i % num];
    return res;
  }

public:

  //! Ctor.
  ActAPI_Color() : Quantity_Color (),
                   m_bIsDefined   (Standard_False) {}

  //! Ctor.
  ActAPI_Color(Quantity_NameOfColor name) : Quantity_Color (name),
                                            m_bIsDefined   (Standard_True) {}

  //! Ctor.
  ActAPI_Color(const Standard_Real        R1,
               const Standard_Real        R2,
               const Standard_Real        R3,
               const Quantity_TypeOfColor Type) : Quantity_Color (R1, R2, R3, Type),
                                                  m_bIsDefined   (Standard_True) {}

public:

  //! \return true if the color is defined.
  Standard_Boolean IsDefined() const
  {
    return m_bIsDefined;
  }

protected:

  Standard_Boolean m_bIsDefined; //!< Whether the color is defined or not.

};

//-----------------------------------------------------------------------------

#define Color_Default   ActAPI_Color(Quantity_NOC_SNOW)
#define Color_Red       ActAPI_Color(250./255., 60./255., 15./255., Quantity_TOC_RGB)
#define Color_Orange    ActAPI_Color(Quantity_NOC_ORANGE)
#define Color_Purple    ActAPI_Color(Quantity_NOC_PURPLE)
#define Color_Pink      ActAPI_Color(Quantity_NOC_PINK)
#define Color_Green     ActAPI_Color(140./255., 220./255., 40./255., Quantity_TOC_RGB)
#define Color_Khaki     ActAPI_Color(Quantity_NOC_KHAKI)
#define Color_Blue      ActAPI_Color(50./255., 150./255., 255./255., Quantity_TOC_RGB)
#define Color_Yellow    ActAPI_Color(Quantity_NOC_YELLOW)
#define Color_White     ActAPI_Color(Quantity_NOC_WHITE)
#define Color_Snow      ActAPI_Color(Quantity_NOC_SNOW)
#define Color_Black     ActAPI_Color(Quantity_NOC_BLACK)
#define Color_Violet    ActAPI_Color(Quantity_NOC_VIOLET)
#define Color_Magenta   ActAPI_Color(Quantity_NOC_MAGENTA1)
#define Color_Maroon    ActAPI_Color(Quantity_NOC_MAROON)
#define Color_LightGray ActAPI_Color(Quantity_NOC_LIGHTGRAY)
#define Color_DarkGray  ActAPI_Color(0.4, 0.4, 0.4, Quantity_TOC_RGB)

//-----------------------------------------------------------------------------

//! \ingroup AD_DF
//!
//! Interface for Imperative Viewer. A particular algorithm may benefit
//! from immediate plotting of its geometric variables in a unified way
//! thanks to this abstract class.
class ActAPI_IPlotter : public Standard_Transient
{
  // OCCT RTTI
  DEFINE_STANDARD_RTTI_INLINE(ActAPI_IPlotter, Standard_Transient)

public:

  ActData_EXPORT static Quantity_NameOfColor
    Color_Sparse(const int index);

public:

  ActData_EXPORT virtual
    ~ActAPI_IPlotter();

// COMMON:
public:

  virtual void
    ERASE_ALL() {}

  virtual void
    ERASE(const t_extString&) {}

  virtual void
    FIT3D() {}

  virtual void
    SHOW_HISTORY(const t_extString&,
                 const Handle(Standard_Transient)&) {};

// GEOMETRY:
public:

  //-------------------------------------------------------------------------//

  virtual void
    DRAW_POINT(const gp_XY&,
               const ActAPI_Color&,
               const t_extString&) {}

  virtual void
    DRAW_POINT(const gp_Pnt2d&,
               const ActAPI_Color&,
               const t_extString&) {}

  virtual void
    DRAW_POINT(const gp_XYZ&,
               const ActAPI_Color&,
               const t_extString&) {}

  virtual void
    DRAW_POINT(const gp_Pnt&,
               const ActAPI_Color&,
               const t_extString&) {}

  virtual void
    REDRAW_POINT(const t_extString&,
                 const gp_XY&,
                 const ActAPI_Color&) {}

  virtual void
    REDRAW_POINT(const t_extString&,
                 const gp_Pnt2d&,
                 const ActAPI_Color&) {}

  virtual void
    REDRAW_POINT(const t_extString&,
                 const gp_XYZ&,
                 const ActAPI_Color&) {}

  virtual void
    REDRAW_POINT(const t_extString&,
                 const gp_Pnt&,
                 const ActAPI_Color&) {}

  //-------------------------------------------------------------------------//

  virtual void
    DRAW_POINTS(const Handle(HRealArray)&,
                const ActAPI_Color&,
                const t_extString&) {}

  virtual void
    DRAW_POINTS(const Handle(HRealArray)&,
                const float,
                const bool,
                const ActAPI_Color&,
                const t_extString&) {}

  virtual void
    DRAW_POINTS(const std::vector<gp_XYZ>&,
                const ActAPI_Color&,
                const t_extString&) {}

  virtual void
    DRAW_POINTS(const std::vector<gp_Pnt>&,
                const ActAPI_Color&,
                const t_extString&) {}

  virtual void
    REDRAW_POINTS(const t_extString&,
                  const Handle(HRealArray)&,
                  const ActAPI_Color&) {}

  virtual void
    REDRAW_POINTS(const t_extString&,
                  const Handle(HRealArray)&,
                  const float,
                  const bool,
                  const ActAPI_Color&) {}

  virtual void
    REDRAW_POINTS(const t_extString&,
                  const std::vector<gp_XYZ>&,
                  const ActAPI_Color&) {}

  virtual void
    REDRAW_POINTS(const t_extString&,
                  const std::vector<gp_Pnt>&,
                  const ActAPI_Color&) {}

  //-------------------------------------------------------------------------//

  virtual void
    DRAW_VECTOR_AT(const gp_Pnt&,
                   const gp_Vec&,
                   const ActAPI_Color&,
                   const t_extString&) {}

  virtual void
    REDRAW_VECTOR_AT(const t_extString&,
                     const gp_Pnt&,
                     const gp_Vec&,
                     const ActAPI_Color&) {}

  virtual void
    REDRAW_VECTOR_AT(const t_extString&,
                     const gp_Pnt&,
                     const gp_Vec&,
                     const ActAPI_Color&,
                     const double /* lineWidth */) {}

  //-------------------------------------------------------------------------//

  virtual void
    DRAW_VECTORS_AT(const gp_Pnt&,
                    const std::vector<gp_Vec>&,
                    const ActAPI_Color&,
                    const t_extString&) {}

  virtual void
    REDRAW_VECTORS_AT(const t_extString&,
                      const gp_Pnt&,
                      const std::vector<gp_Vec>&,
                      const ActAPI_Color&) {}

  //-------------------------------------------------------------------------//

  virtual void
    DRAW_VECTORS(const Handle(HRealArray)&,
                 const Handle(HRealArray)&,
                 const ActAPI_Color&,
                 const t_extString&) {}

  virtual void
    REDRAW_VECTORS(const t_extString&,
                   const Handle(HRealArray)&,
                   const Handle(HRealArray)&,
                   const ActAPI_Color&) {}

  //-------------------------------------------------------------------------//

  virtual void
    DRAW_VECTORS(const Handle(HRealArray)&,
                 const Handle(HRealArray)&,
                 const ActAPI_Color&,
                 const bool, // with tip
                 const bool, // rescale
                 const t_extString&) {}

  virtual void
    REDRAW_VECTORS(const t_extString&,
                   const Handle(HRealArray)&,
                   const Handle(HRealArray)&,
                   const ActAPI_Color&,
                   const bool,    // with tip
                   const bool) {} // rescale

  //-------------------------------------------------------------------------//

  virtual void
    DRAW_LABELS(const Handle(HRealArray)&,
                const Handle(HStringArray)&,
                const ActAPI_Color&,
                const t_extString&) {}

  virtual void
    REDRAW_LABELS(const t_extString&,
                  const Handle(HRealArray)&,
                  const Handle(HStringArray)&,
                  const ActAPI_Color&) {}

  virtual void
    DRAW_LABEL(const gp_XYZ&,
               const t_asciiString&,
               const ActAPI_Color&,
               const t_extString&) {}

  virtual void
    REDRAW_LABEL(const t_extString&,
                 const gp_XYZ&,
                 const t_asciiString&,
                 const ActAPI_Color&) {}

  //-------------------------------------------------------------------------//

  virtual void
    DRAW_RECT(const gp_Pnt2d&,
              const gp_Pnt2d&,
              const ActAPI_Color&,
              const t_extString&) {}

  virtual void
    REDRAW_RECT(const t_extString&,
                const gp_Pnt2d&,
                const gp_Pnt2d&,
                const ActAPI_Color&) {}

  //-------------------------------------------------------------------------//

  virtual void
    DRAW_AXES(const gp_Pnt&,
              const gp_Dir&,
              const gp_Dir&,
              const gp_Dir&,
              const double,
              const Handle(ActAPI_INode)&,
              const t_extString&) {}

  virtual void
    REDRAW_AXES(const t_extString&,
                const gp_Pnt&,
                const gp_Dir&,
                const gp_Dir&,
                const gp_Dir&,
                const double,
                const Handle(ActAPI_INode)&) {}

  //-------------------------------------------------------------------------//

  virtual void
    DRAW_CURVE(const Handle(Geom_Curve)&,
               const ActAPI_Color&,
               const bool,
               const t_extString&) {}

  virtual void
    DRAW_CURVE(const Handle(Geom_Curve)&,
               const ActAPI_Color&,
               const t_extString&) {}

  virtual void
    REDRAW_CURVE(const TCollection_ExtendedString&,
                 const Handle(Geom_Curve)&,
                 const ActAPI_Color&,
                 const bool) {}

  virtual void
    REDRAW_CURVE(const TCollection_ExtendedString&,
                 const Handle(Geom_Curve)&,
                 const ActAPI_Color&) {}

  //-------------------------------------------------------------------------//

  virtual void
    DRAW_CURVE2D(const Handle(Geom2d_Curve)&,
                 const ActAPI_Color&,
                 const bool,
                 const t_extString&) {}

  virtual void
    DRAW_CURVE2D(const Handle(Geom2d_Curve)&,
                 const ActAPI_Color&,
                 const t_extString&) {}

  virtual void
    REDRAW_CURVE2D(const t_extString&,
                   const Handle(Geom2d_Curve)&,
                   const ActAPI_Color&,
                   const bool) {}

  virtual void
    REDRAW_CURVE2D(const t_extString&,
                   const Handle(Geom2d_Curve)&,
                   const ActAPI_Color&) {}

  virtual void
    DRAW_CURVES2D(const std::vector<Handle(Geom2d_Curve)>&,
                  const ActAPI_Color&,
                  const t_extString&) {}

  virtual void
    REDRAW_CURVES2D(const t_extString&,
                    const std::vector<Handle(Geom2d_Curve)>&,
                    const ActAPI_Color&) {}

  //-------------------------------------------------------------------------//

  virtual void
    DRAW_SURFACE(const Handle(Geom_Surface)&,
                 const ActAPI_Color&,
                 const t_extString&) {}

  virtual void
    DRAW_SURFACE(const Handle(Geom_Surface)&,
                 const ActAPI_Color&,
                 const double, // opacity
                 const t_extString&) {}

  virtual void
    DRAW_SURFACE(const Handle(Geom_Surface)&,
                 const double, // U min
                 const double, // U max
                 const double, // V min
                 const double, // V max
                 const ActAPI_Color&,
                 const t_extString&) {}

  virtual void
    DRAW_SURFACE(const Handle(Geom_Surface)&,
                 const double, // U min
                 const double, // U max
                 const double, // V min
                 const double, // V max
                 const ActAPI_Color&,
                 const double, // opacity
                 const t_extString&) {}

  virtual void
    REDRAW_SURFACE(const t_extString&,
                   const Handle(Geom_Surface)&,
                   const ActAPI_Color&) {}

  virtual void
    REDRAW_SURFACE(const t_extString&,
                   const Handle(Geom_Surface)&,
                   const ActAPI_Color&,
                   const double) {} // opacity

  virtual void
    REDRAW_SURFACE(const t_extString&,
                   const Handle(Geom_Surface)&,
                   const double, // U min
                   const double, // U max
                   const double, // V min
                   const double, // V max
                   const ActAPI_Color&) {}

  virtual void
    REDRAW_SURFACE(const t_extString&,
                   const Handle(Geom_Surface)&,
                   const double, // U min
                   const double, // U max
                   const double, // V min
                   const double, // V max
                   const ActAPI_Color&,
                   const double) {} // opacity

// TOPOLOGY:
public:

  virtual void
    DRAW_SHAPE(const TopoDS_Shape&,
               const t_extString&) {}

  virtual void
    DRAW_SHAPE(const TopoDS_Shape&,
               const ActAPI_Color&,
               const t_extString&) {}

  virtual void
    DRAW_SHAPE(const TopoDS_Shape&,
               const double, // opacity
               const t_extString&) {}

  virtual void
    DRAW_SHAPE(const TopoDS_Shape&,
               const ActAPI_Color&,
               const double, // opacity
               const t_extString&) {}

  virtual void
    DRAW_SHAPE(const TopoDS_Shape&,
               const ActAPI_Color&,
               const double, // opacity
               const bool, // is wireframe
               const t_extString&) {}

  virtual void
    REDRAW_SHAPE(const t_extString&,
                 const TopoDS_Shape&) {}

  virtual void
    REDRAW_SHAPE(const t_extString&,
                 const TopoDS_Shape&,
                 const ActAPI_Color&) {}

  virtual void
    REDRAW_SHAPE(const t_extString&,
                 const TopoDS_Shape&,
                 const double) {} // opacity

  virtual void
    REDRAW_SHAPE(const t_extString&,
                 const TopoDS_Shape&,
                 const ActAPI_Color&,
                 const double) {} // opacity

  virtual void
    REDRAW_SHAPE(const t_extString&,
                 const TopoDS_Shape&,
                 const ActAPI_Color&,
                 const double, // opacity
                 const bool) {} // is wireframe

  virtual void
    REDRAW_SHAPE(const t_extString&,
                 const TopoDS_Shape&,
                 const ActAPI_Color&,
                 const double, // opacity
                 const bool,   // is wireframe
                 const double) {} // line width

// FACETED GEOMETRY:
public:

  virtual void
    DRAW_LINK(const gp_Pnt&,
              const gp_Pnt&,
              const ActAPI_Color&,
              const t_extString&) {}

  virtual void
    DRAW_LINK(const gp_XYZ&,
              const gp_XYZ&,
              const ActAPI_Color&,
              const t_extString&) {}

  virtual void
    DRAW_LINK(const gp_Pnt2d&,
              const gp_Pnt2d&,
              const ActAPI_Color&,
              const t_extString&) {}

  virtual void
    DRAW_LINK(const gp_XY&,
              const gp_XY&,
              const ActAPI_Color&,
              const t_extString&) {}

  virtual void
    REDRAW_LINK(const t_extString&,
                const gp_Pnt&,
                const gp_Pnt&,
                const ActAPI_Color&) {}

  virtual void
    REDRAW_LINK(const t_extString&,
                const gp_XYZ&,
                const gp_XYZ&,
                const ActAPI_Color&) {}

  virtual void
    REDRAW_LINK(const t_extString&,
                const gp_Pnt2d&,
                const gp_Pnt2d&,
                const ActAPI_Color&) {}

  virtual void
    REDRAW_LINK(const t_extString&,
                const gp_XY&,
                const gp_XY&,
                const ActAPI_Color&) {}

  //-------------------------------------------------------------------------//

  virtual void
    DRAW_POLYLINE(const std::vector<gp_XY>&,
                  const ActAPI_Color&,
                  const t_extString&) {}

  virtual void
    DRAW_POLYLINE(const std::vector<gp_XYZ>&,
                  const ActAPI_Color&,
                  const t_extString&) {}

  virtual void
    DRAW_POLYLINE(const std::vector<gp_XYZ>&,
                  const ActAPI_Color&,
                  const double /*lineWidth*/,
                  const t_extString&) {}

  virtual void
    REDRAW_POLYLINE(const t_extString&,
                    const std::vector<gp_XY>&,
                    const ActAPI_Color&) {}

  virtual void
    REDRAW_POLYLINE(const t_extString&,
                    const std::vector<gp_XYZ>&,
                    const ActAPI_Color&) {}

  //-------------------------------------------------------------------------//

  virtual void
    DRAW_TRIANGLE(const gp_Pnt&,
                  const gp_Pnt&,
                  const gp_Pnt&,
                  const ActAPI_Color&,
                  const t_extString&) {}

  virtual void
    DRAW_TRIANGLE(const gp_XYZ&,
                  const gp_XYZ&,
                  const gp_XYZ&,
                  const ActAPI_Color&,
                  const t_extString&) {}

  virtual void
    DRAW_TRIANGLE(const gp_Pnt2d&,
                  const gp_Pnt2d&,
                  const gp_Pnt2d&,
                  const ActAPI_Color&,
                  const t_extString&) {}

  virtual void
    DRAW_TRIANGLE(const gp_XY&,
                  const gp_XY&,
                  const gp_XY&,
                  const ActAPI_Color&,
                  const t_extString&) {}

  virtual void
    REDRAW_TRIANGLE(const t_extString&,
                    const gp_Pnt&,
                    const gp_Pnt&,
                    const gp_Pnt&,
                    const ActAPI_Color&) {}

  virtual void
    REDRAW_TRIANGLE(const t_extString&,
                    const gp_XYZ&,
                    const gp_XYZ&,
                    const gp_XYZ&,
                    const ActAPI_Color&) {}

  virtual void
    REDRAW_TRIANGLE(const t_extString&,
                    const gp_Pnt2d&,
                    const gp_Pnt2d&,
                    const gp_Pnt2d&,
                    const ActAPI_Color&) {}

  virtual void
    REDRAW_TRIANGLE(const t_extString&,
                    const gp_XY&,
                    const gp_XY&,
                    const gp_XY&,
                    const ActAPI_Color&) {}

  //-------------------------------------------------------------------------//

  virtual void
    DRAW_TRIANGULATION(const Handle(Poly_Triangulation)&,
                       const ActAPI_Color&,
                       const double, // opacity
                       const t_extString&) {}

  virtual void
    REDRAW_TRIANGULATION(const t_extString&,
                         const Handle(Poly_Triangulation)&,
                         const ActAPI_Color&,
                         const double) {} // opacity

  //-------------------------------------------------------------------------//

  virtual void
    DRAW_MESH(const Handle(ActData_Mesh)&,
              const ActAPI_Color&,
              const double, // opacity
              const double, // edge width
              const t_extString&) {}

  virtual void
    REDRAW_MESH(const t_extString&,
                const Handle(ActData_Mesh)&,
                const ActAPI_Color&,
                const double, // opacity
                const double) {} // edge width
// TEXT
public:

  virtual void
    DRAW_TEXT(const t_extString&, // text
              const t_extString&) {} // name

  virtual void
    REDRAW_TEXT(const t_extString&, // name
                const t_extString&) {} // text

};

//-----------------------------------------------------------------------------

//! \ingroup AD_DF
//!
//! Safe entry to IV.
class ActAPI_PlotterEntry
{
public:

  //! Default constructor.
  ActAPI_PlotterEntry() {}

  //! Dummy conversion constructor.
  ActAPI_PlotterEntry(std::nullptr_t) {}

  //! Constructor.
  //! \param iv [in] IV to wrap.
  ActAPI_PlotterEntry(const Handle(ActAPI_IPlotter)& iv) : m_iv(iv) {}

public:

  //! Assignment operator.
  //! \param iv [in] IV to wrap.
  void operator=(const Handle(ActAPI_IPlotter)& iv)
  {
    m_iv = iv;
  }

public:

  //! \return Journal instance.
  const Handle(ActAPI_IPlotter)& Access() const { return m_iv; }

public:

//---------------------------------------------------------------------------//

  void
    ERASE_ALL()
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->ERASE_ALL();
  }

//---------------------------------------------------------------------------//

  void
    ERASE(const t_extString& name)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->ERASE(name);
  }

//---------------------------------------------------------------------------//

  void
    FIT3D()
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->FIT3D();
  }

//---------------------------------------------------------------------------//

  void
    SHOW_HISTORY(const t_extString&                title,
                 const Handle(Standard_Transient)& history)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->SHOW_HISTORY(title, history);
  }

public:

//---------------------------------------------------------------------------//

  void
    DRAW_POINT(const gp_XY&        coord,
               const ActAPI_Color& color,
               const t_extString&  name = "")
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_POINT(coord, color, name);
  }

//---------------------------------------------------------------------------//

  void
    DRAW_POINT(const gp_Pnt2d&     point,
               const ActAPI_Color& color,
               const t_extString&  name = "")
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_POINT(point, color, name);
  }

//---------------------------------------------------------------------------//

  void
    DRAW_POINT(const gp_XYZ&       coord,
               const ActAPI_Color& color,
               const t_extString&  name = "")
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_POINT(coord, color, name);
  }

//---------------------------------------------------------------------------//

  void
    DRAW_POINT(const gp_Pnt&       point,
               const ActAPI_Color& color,
               const t_extString&  name = "")
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_POINT(point, color, name);
  }

//---------------------------------------------------------------------------//

  void
    REDRAW_POINT(const t_extString&  name,
                 const gp_XY&        point,
                 const ActAPI_Color& color)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_POINT(name, point, color);
  }

//---------------------------------------------------------------------------//

  void
    REDRAW_POINT(const t_extString&  name,
                 const gp_Pnt2d&     point,
                 const ActAPI_Color& color)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_POINT(name, point, color);
  }

//---------------------------------------------------------------------------//

  void
    REDRAW_POINT(const t_extString&  name,
                 const gp_XYZ&       point,
                 const ActAPI_Color& color)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_POINT(name, point, color);
  }

//---------------------------------------------------------------------------//

  void
    REDRAW_POINT(const t_extString&  name,
                 const gp_Pnt&       point,
                 const ActAPI_Color& color)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_POINT(name, point, color);
  }

//---------------------------------------------------------------------------//

  void
    DRAW_POINTS(const Handle(HRealArray)& coords,
                const ActAPI_Color&       color,
                const t_extString&        name = "")
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_POINTS(coords, color, name);
  }

//---------------------------------------------------------------------------//

  void
    DRAW_POINTS(const Handle(HRealArray)& coords,
                const float               size,
                const bool                labels,
                const ActAPI_Color&       color,
                const t_extString&        name = "")
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_POINTS(coords, size, labels, color, name);
  }

//---------------------------------------------------------------------------//

  void
    DRAW_POINTS(const std::vector<gp_XYZ>& pts,
                const ActAPI_Color&        color,
                const t_extString&         name = "")
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_POINTS(pts, color, name);
  }

//---------------------------------------------------------------------------//

  void
    DRAW_POINTS(const std::vector<gp_Pnt>& pts,
                const ActAPI_Color&        color,
                const t_extString&         name = "")
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_POINTS(pts, color, name);
  }

//---------------------------------------------------------------------------//

  void
    REDRAW_POINTS(const t_extString&        name,
                  const Handle(HRealArray)& coords,
                  const ActAPI_Color&       color)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_POINTS(name, coords, color);
  }

//---------------------------------------------------------------------------//

  void
    REDRAW_POINTS(const t_extString&        name,
                  const Handle(HRealArray)& coords,
                  const float               size,
                  const bool                labels,
                  const ActAPI_Color&       color)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_POINTS(name, coords, size, labels, color);
  }

//---------------------------------------------------------------------------//

  void
    REDRAW_POINTS(const t_extString&         name,
                  const std::vector<gp_XYZ>& pts,
                  const ActAPI_Color&        color)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_POINTS(name, pts, color);
  }

//-------------------------------------------------------------------------//

  virtual void
    DRAW_VECTORS(const Handle(HRealArray)& points,
                 const Handle(HRealArray)& vectors,
                 const ActAPI_Color&       color,
                 const t_extString&        name)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_VECTORS(points, vectors, color, name);
  }

//-------------------------------------------------------------------------//

  virtual void
    REDRAW_VECTORS(const t_extString&        name,
                   const Handle(HRealArray)& points,
                   const Handle(HRealArray)& vectors,
                   const ActAPI_Color&       color)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_VECTORS(name, points, vectors, color);
  }

//-------------------------------------------------------------------------//

  virtual void
    DRAW_VECTORS(const Handle(HRealArray)& points,
                 const Handle(HRealArray)& vectors,
                 const ActAPI_Color&       color,
                 const bool                tips,
                 const bool                rescale,
                 const t_extString&        name)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_VECTORS(points, vectors, color, tips, rescale, name);
  }

//-------------------------------------------------------------------------//

  virtual void
    REDRAW_VECTORS(const t_extString&        name,
                   const Handle(HRealArray)& points,
                   const Handle(HRealArray)& vectors,
                   const ActAPI_Color&       color,
                   const bool                tips,
                   const bool                rescale)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_VECTORS(name, points, vectors, color, tips, rescale);
  }

//-------------------------------------------------------------------------//

  virtual void
    DRAW_LABELS(const Handle(HRealArray)&   points,
                const Handle(HStringArray)& labels,
                const ActAPI_Color&         color,
                const t_extString&          name)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_LABELS(points, labels, color, name);
  }

//-------------------------------------------------------------------------//

  virtual void
    REDRAW_LABELS(const t_extString&          name,
                  const Handle(HRealArray)&   points,
                  const Handle(HStringArray)& labels,
                  const ActAPI_Color&         color)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_LABELS(name, points, labels, color);
  }

//-------------------------------------------------------------------------//

  virtual void
    DRAW_LABEL(const gp_XYZ&        point,
               const t_asciiString& label,
               const ActAPI_Color&  color,
               const t_extString&   name)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_LABEL(point, label, color, name);
  }

//-------------------------------------------------------------------------//

  virtual void
    REDRAW_LABEL(const t_extString&   name,
                 const gp_XYZ&        point,
                 const t_asciiString& label,
                 const ActAPI_Color&  color)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_LABEL(name, point, label, color);
  }

//---------------------------------------------------------------------------//

  void
    DRAW_VECTOR_AT(const gp_Pnt&       P,
                   const gp_Vec&       V,
                   const ActAPI_Color& color,
                   const t_extString&  name = "")
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_VECTOR_AT(P, V, color, name);
  }

//---------------------------------------------------------------------------//

  void
    REDRAW_VECTOR_AT(const t_extString&  name,
                     const gp_Pnt&       P,
                     const gp_Vec&       V,
                     const ActAPI_Color& color)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_VECTOR_AT(name, P, V, color);
  }

  void
    REDRAW_VECTOR_AT(const t_extString&  name,
                     const gp_Pnt&       P,
                     const gp_Vec&       V,
                     const ActAPI_Color& color,
                     const double        lineWidth)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_VECTOR_AT(name, P, V, color, lineWidth);
  }

//---------------------------------------------------------------------------//

  void
    DRAW_VECTORS_AT(const gp_Pnt&              origin,
                    const std::vector<gp_Vec>& vectors,
                    const ActAPI_Color&        color,
                    const t_extString&         name = "")
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_VECTORS_AT(origin, vectors, color, name);
  }

//---------------------------------------------------------------------------//

  void
    REDRAW_VECTORS_AT(const t_extString&         name,
                      const gp_Pnt&              origin,
                      const std::vector<gp_Vec>& vectors,
                      const ActAPI_Color&        color)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_VECTORS_AT(name, origin, vectors, color);
  }

//---------------------------------------------------------------------------//

  void
    DRAW_AXES(const gp_Pnt&               origin,
              const gp_Dir&               dx,
              const gp_Dir&               dy,
              const gp_Dir&               dz,
              const double                scale,
              const Handle(ActAPI_INode)& ref,
              const t_extString&          name = "")
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_AXES(origin, dx, dy, dz, scale, ref, name);
  }

//---------------------------------------------------------------------------//

  void
    REDRAW_AXES(const t_extString&          name,
                const gp_Pnt&               origin,
                const gp_Dir&               dx,
                const gp_Dir&               dy,
                const gp_Dir&               dz,
                const double                scale,
                const Handle(ActAPI_INode)& ref)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_AXES(name, origin, dx, dy, dz, scale, ref);
  }

//-------------------------------------------------------------------------//

  void
    DRAW_RECT(const gp_Pnt2d&     Pmin,
              const gp_Pnt2d&     Pmax,
              const ActAPI_Color& color,
              const t_extString&  name = "")
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_RECT(Pmin, Pmax, color, name);
  }

//-------------------------------------------------------------------------//

  void
    REDRAW_RECT(const t_extString&  name,
                const gp_Pnt2d&     Pmin,
                const gp_Pnt2d&     Pmax,
                const ActAPI_Color& color)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_RECT(name, Pmin, Pmax, color);
  }

//---------------------------------------------------------------------------//

  void
    DRAW_CURVE(const Handle(Geom_Curve)&         curve,
               const ActAPI_Color&               color,
               const bool                        showOri,
               const TCollection_ExtendedString& name = "")
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_CURVE(curve, color, showOri, name);
  }

//---------------------------------------------------------------------------//

  void
    DRAW_CURVE(const Handle(Geom_Curve)&         curve,
               const ActAPI_Color&               color,
               const TCollection_ExtendedString& name = "")
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_CURVE(curve, color, true, name);
  }

//---------------------------------------------------------------------------//

  void
    REDRAW_CURVE(const TCollection_ExtendedString& name,
                 const Handle(Geom_Curve)&         curve,
                 const ActAPI_Color&               color,
                 const bool                        showOri)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_CURVE(name, curve, color, showOri);
  }

//---------------------------------------------------------------------------//

  void
    REDRAW_CURVE(const TCollection_ExtendedString& name,
                 const Handle(Geom_Curve)&         curve,
                 const ActAPI_Color&               color)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_CURVE(name, curve, color, true);
  }

//---------------------------------------------------------------------------//

  void
    DRAW_CURVE2D(const Handle(Geom2d_Curve)& curve,
                 const ActAPI_Color&         color,
                 const bool                  showOri,
                 const t_extString&          name = "")
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_CURVE2D(curve, color, showOri, name);
  }

//---------------------------------------------------------------------------//

  void
    DRAW_CURVE2D(const Handle(Geom2d_Curve)& curve,
                 const ActAPI_Color&         color,
                 const t_extString&          name = "")
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_CURVE2D(curve, color, true, name);
  }

//---------------------------------------------------------------------------//

  void
    REDRAW_CURVE2D(const t_extString&          name,
                   const Handle(Geom2d_Curve)& curve,
                   const ActAPI_Color&         color,
                   const bool                  showOri)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_CURVE2D(name, curve, color, showOri);
  }

//---------------------------------------------------------------------------//

  void
    REDRAW_CURVE2D(const t_extString&          name,
                   const Handle(Geom2d_Curve)& curve,
                   const ActAPI_Color&         color)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_CURVE2D(name, curve, color, true);
  }

//---------------------------------------------------------------------------//

  void
    DRAW_CURVES2D(const std::vector<Handle(Geom2d_Curve)>& curves,
                  const ActAPI_Color&                      color,
                  const t_extString&                       name)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_CURVES2D(curves, color, name);
  }

  void
    REDRAW_CURVES2D(const t_extString&                       name,
                    const std::vector<Handle(Geom2d_Curve)>& curves,
                    const ActAPI_Color&                      color)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_CURVES2D(name, curves, color);
  }

//---------------------------------------------------------------------------//

  void
    DRAW_SURFACE(const Handle(Geom_Surface)& surface,
                 const ActAPI_Color&         color,
                 const t_extString&          name = "")
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_SURFACE(surface, color, name);
  }

//---------------------------------------------------------------------------//

  void
    DRAW_SURFACE(const Handle(Geom_Surface)& surface,
                 const ActAPI_Color&         color,
                 const double                opacity,
                 const t_extString&          name = "")
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_SURFACE(surface, color, opacity, name);
  }

//---------------------------------------------------------------------------//

  void
    DRAW_SURFACE(const Handle(Geom_Surface)& surface,
                 const double                uMin,
                 const double                uMax,
                 const double                vMin,
                 const double                vMax,
                 const ActAPI_Color&         color,
                 const t_extString&          name = "")
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_SURFACE(surface, uMin, uMax, vMin, vMax, color, name);
  }

//---------------------------------------------------------------------------//

  void
    DRAW_SURFACE(const Handle(Geom_Surface)& surface,
                 const double                uMin,
                 const double                uMax,
                 const double                vMin,
                 const double                vMax,
                 const ActAPI_Color&         color,
                 const double                opacity,
                 const t_extString&          name = "")
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_SURFACE(surface, uMin, uMax, vMin, vMax, color, opacity, name);
  }

//---------------------------------------------------------------------------//

  void
    REDRAW_SURFACE(const t_extString&          name,
                   const Handle(Geom_Surface)& surface,
                   const ActAPI_Color&         color)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_SURFACE(name, surface, color);
  }

//---------------------------------------------------------------------------//

  virtual void
    REDRAW_SURFACE(const t_extString&          name,
                   const Handle(Geom_Surface)& surface,
                   const ActAPI_Color&         color,
                   const double                opacity)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_SURFACE(name, surface, color, opacity);
  }

//---------------------------------------------------------------------------//

  virtual void
    REDRAW_SURFACE(const t_extString&          name,
                   const Handle(Geom_Surface)& surface,
                   const double                uMin,
                   const double                uMax,
                   const double                vMin,
                   const double                vMax,
                   const ActAPI_Color&         color)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_SURFACE(name, surface, uMin, uMax, vMin, vMax, color);
  }

//---------------------------------------------------------------------------//

  virtual void
    REDRAW_SURFACE(const t_extString&          name,
                   const Handle(Geom_Surface)& surface,
                   const double                uMin,
                   const double                uMax,
                   const double                vMin,
                   const double                vMax,
                   const ActAPI_Color&         color,
                   const double                opacity)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_SURFACE(name, surface, uMin, uMax, vMin, vMax, color, opacity);
  }

//---------------------------------------------------------------------------//

  void
    DRAW_SHAPE(const TopoDS_Shape& shape,
               const t_extString&  name = "")
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_SHAPE(shape, name);
  }

//---------------------------------------------------------------------------//

  void
    DRAW_SHAPE(const TopoDS_Shape& shape,
               const ActAPI_Color& color,
               const t_extString&  name = "")
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_SHAPE(shape, color, name);
  }

//---------------------------------------------------------------------------//

  void
    DRAW_SHAPE(const TopoDS_Shape& shape,
               const double        opacity,
               const t_extString&  name = "")
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_SHAPE(shape, opacity, name);
  }

//---------------------------------------------------------------------------//

  void
    DRAW_SHAPE(const TopoDS_Shape& shape,
               const ActAPI_Color& color,
               const double        opacity,
               const t_extString&  name = "")
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_SHAPE(shape, color, opacity, name);
  }

//---------------------------------------------------------------------------//

  void
    DRAW_SHAPE(const TopoDS_Shape& shape,
               const ActAPI_Color& color,
               const double        opacity,
               const bool          isWireframe,
               const t_extString&  name = "")
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_SHAPE(shape, color, opacity, isWireframe, name);
  }

//---------------------------------------------------------------------------//

  void
    REDRAW_SHAPE(const t_extString&  name,
                 const TopoDS_Shape& shape)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_SHAPE(name, shape);
  }

//---------------------------------------------------------------------------//

  virtual void
    REDRAW_SHAPE(const t_extString&  name,
                 const TopoDS_Shape& shape,
                 const ActAPI_Color& color)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_SHAPE(name, shape, color);
  }

//---------------------------------------------------------------------------//

  virtual void
    REDRAW_SHAPE(const t_extString&  name,
                 const TopoDS_Shape& shape,
                 const double        opacity)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_SHAPE(name, shape, opacity);
  }

//---------------------------------------------------------------------------//

  virtual void
    REDRAW_SHAPE(const t_extString&  name,
                 const TopoDS_Shape& shape,
                 const ActAPI_Color& color,
                 const double        opacity)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_SHAPE(name, shape, color, opacity);
  }

//---------------------------------------------------------------------------//

  virtual void
    REDRAW_SHAPE(const t_extString&  name,
                 const TopoDS_Shape& shape,
                 const ActAPI_Color& color,
                 const double        opacity,
                 const bool          isWireframe)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_SHAPE(name, shape, color, opacity, isWireframe);
  }

//---------------------------------------------------------------------------//

  virtual void
    REDRAW_SHAPE(const t_extString&  name,
                 const TopoDS_Shape& shape,
                 const ActAPI_Color& color,
                 const double        opacity,
                 const bool          isWireframe,
                 const double        lineWidth)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_SHAPE(name, shape, color, opacity, isWireframe, lineWidth);
  }

//---------------------------------------------------------------------------//

  void
    DRAW_LINK(const gp_Pnt&       p1,
              const gp_Pnt&       p2,
              const ActAPI_Color& color,
              const t_extString&  name = "")
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_LINK(p1, p2, color, name);
  }

//---------------------------------------------------------------------------//

  void
    DRAW_LINK(const gp_XYZ&       p1,
              const gp_XYZ&       p2,
              const ActAPI_Color& color,
              const t_extString&  name = "")
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_LINK(p1, p2, color, name);
  }

//---------------------------------------------------------------------------//

  void
    DRAW_LINK(const gp_Pnt2d&     p1,
              const gp_Pnt2d&     p2,
              const ActAPI_Color& color,
              const t_extString&  name = "")
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_LINK(p1, p2, color, name);
  }

//---------------------------------------------------------------------------//

  void
    DRAW_LINK(const gp_XY&        p1,
              const gp_XY&        p2,
              const ActAPI_Color& color,
              const t_extString&  name = "")
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_LINK(p1, p2, color, name);
  }

//---------------------------------------------------------------------------//

  void
    REDRAW_LINK(const t_extString&  name,
                const gp_Pnt&       p1,
                const gp_Pnt&       p2,
                const ActAPI_Color& color)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_LINK(name, p1, p2, color);
  }

//---------------------------------------------------------------------------//

  void
    REDRAW_LINK(const t_extString&  name,
                const gp_XYZ&       p1,
                const gp_XYZ&       p2,
                const ActAPI_Color& color)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_LINK(name, p1, p2, color);
  }

//---------------------------------------------------------------------------//

  void
    REDRAW_LINK(const t_extString&  name,
                const gp_Pnt2d&     p1,
                const gp_Pnt2d&     p2,
                const ActAPI_Color& color)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_LINK(name, p1, p2, color);
  }

//---------------------------------------------------------------------------//

  void
    REDRAW_LINK(const t_extString&  name,
                const gp_XY&        p1,
                const gp_XY&        p2,
                const ActAPI_Color& color)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_LINK(name, p1, p2, color);
  }

//---------------------------------------------------------------------------//

  void
    DRAW_POLYLINE(const std::vector<gp_XY>& poles,
                  const ActAPI_Color&       color,
                  const t_extString&        name)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_POLYLINE(poles, color, name);
  }

//---------------------------------------------------------------------------//

  void
    DRAW_POLYLINE(const std::vector<gp_XYZ>& poles,
                  const ActAPI_Color&        color,
                  const t_extString&         name)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_POLYLINE(poles, color, name);
  }

//---------------------------------------------------------------------------//

  void
    DRAW_POLYLINE(const std::vector<gp_XYZ>& poles,
                  const ActAPI_Color&        color,
                  const double               lineWidth,
                  const t_extString&         name)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_POLYLINE(poles, color, lineWidth, name);
  }

//---------------------------------------------------------------------------//

  void
    REDRAW_POLYLINE(const t_extString&        name,
                    const std::vector<gp_XY>& poles,
                    const ActAPI_Color&       color)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_POLYLINE(name, poles, color);
  }

//---------------------------------------------------------------------------//

  void
    REDRAW_POLYLINE(const t_extString&         name,
                    const std::vector<gp_XYZ>& poles,
                    const ActAPI_Color&        color)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_POLYLINE(name, poles, color);
  }

//---------------------------------------------------------------------------//

  void
    DRAW_TRIANGLE(const gp_Pnt&       p1,
                  const gp_Pnt&       p2,
                  const gp_Pnt&       p3,
                  const ActAPI_Color& color,
                  const t_extString&  name = "")
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_TRIANGLE(p1, p2, p3, color, name);
  }

//---------------------------------------------------------------------------//

  void
    DRAW_TRIANGLE(const gp_XYZ&       p1,
                  const gp_XYZ&       p2,
                  const gp_XYZ&       p3,
                  const ActAPI_Color& color,
                  const t_extString&  name = "")
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_TRIANGLE(p1, p2, p3, color, name);
  }

//---------------------------------------------------------------------------//

  void
    DRAW_TRIANGLE(const gp_Pnt2d&     p1,
                  const gp_Pnt2d&     p2,
                  const gp_Pnt2d&     p3,
                  const ActAPI_Color& color,
                  const t_extString&  name = "")
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_TRIANGLE(p1, p2, p3, color, name);
  }

//---------------------------------------------------------------------------//

  void
    DRAW_TRIANGLE(const gp_XY&        p1,
                  const gp_XY&        p2,
                  const gp_XY&        p3,
                  const ActAPI_Color& color,
                  const t_extString&  name = "")
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_TRIANGLE(p1, p2, p3, color, name);
  }

//---------------------------------------------------------------------------//

  void
    REDRAW_TRIANGLE(const t_extString&  name,
                    const gp_Pnt&       p1,
                    const gp_Pnt&       p2,
                    const gp_Pnt&       p3,
                    const ActAPI_Color& color)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_TRIANGLE(name, p1, p2, p3, color);
  }

//---------------------------------------------------------------------------//

  void
    REDRAW_TRIANGLE(const t_extString&  name,
                    const gp_XYZ&       p1,
                    const gp_XYZ&       p2,
                    const gp_XYZ&       p3,
                    const ActAPI_Color& color)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_TRIANGLE(name, p1, p2, p3, color);
  }

//---------------------------------------------------------------------------//

  void
    REDRAW_TRIANGLE(const t_extString&  name,
                    const gp_Pnt2d&     p1,
                    const gp_Pnt2d&     p2,
                    const gp_Pnt2d&     p3,
                    const ActAPI_Color& color)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_TRIANGLE(name, p1, p2, p3, color);
  }

//---------------------------------------------------------------------------//

  void
    REDRAW_TRIANGLE(const t_extString&  name,
                    const gp_XY&        p1,
                    const gp_XY&        p2,
                    const gp_XY&        p3,
                    const ActAPI_Color& color)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_TRIANGLE(name, p1, p2, p3, color);
  }

//---------------------------------------------------------------------------//

  void
    DRAW_TRIANGULATION(const Handle(Poly_Triangulation)& tess,
                       const ActAPI_Color&               color,
                       const double                      opacity,
                       const t_extString&                name = "")
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_TRIANGULATION(tess, color, opacity, name);
  }

//---------------------------------------------------------------------------//

  void
    REDRAW_TRIANGULATION(const t_extString&                name,
                         const Handle(Poly_Triangulation)& tess,
                         const ActAPI_Color&               color,
                         const double                      opacity)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_TRIANGULATION(name, tess, color, opacity);
  }

//---------------------------------------------------------------------------//

  void
    DRAW_MESH(const Handle(ActData_Mesh)& tess,
              const ActAPI_Color&         color,
              const double                opacity,
              const double                edgeWidth,
              const t_extString&          name = "")
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_MESH(tess, color, opacity, edgeWidth, name);
  }

//---------------------------------------------------------------------------//

  void
    REDRAW_MESH(const t_extString&          name,
                const Handle(ActData_Mesh)& tess,
                const ActAPI_Color&         color,
                const double                opacity,
                const double                edgeWidth)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_MESH(name, tess, color, opacity, edgeWidth);
  }

//---------------------------------------------------------------------------//

  void
    DRAW_TEXT(const t_extString& text,
              const t_extString& name = "")
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->DRAW_TEXT(text, name);
  }

//---------------------------------------------------------------------------//

  void
    REDRAW_TEXT(const t_extString& name,
                const t_extString& text)
  {
    if ( m_iv.IsNull() ) return;
    //
    m_iv->REDRAW_TEXT(name, text);
  }

//---------------------------------------------------------------------------//

private:

  Handle(ActAPI_IPlotter) m_iv; //!< IV instance.

};

#endif
