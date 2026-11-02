//-----------------------------------------------------------------------------
// Created on: 29 October 2021
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

#ifndef asiAlgo_ConvertCanonicalCurve_HeaderFile
#define asiAlgo_ConvertCanonicalCurve_HeaderFile

// asiAlgo includes
#include <asiAlgo.h>

// OpenCascade includes
#include <TColgp_Array1OfPnt.hxx>

class Geom_Curve;
class Geom_Line;
class gp_Lin;
class gp_Pnt;
class gp_Circ;

//-----------------------------------------------------------------------------

//! \ingroup ASI_MODELING
//!
//! Converts the input curve to a canonical form.
class asiAlgo_ConvertCanonicalCurve
{
public:

  //! Attempts to convert this curve to a canonical form.
  asiAlgo_EXPORT static Handle(Geom_Curve)
    ConvertCurve(const Handle(Geom_Curve)& curve,
                 const double              tol,
                 const double              c1,
                 const double              c2,
                 double&                   cf,
                 double&                   cl);

  //! Attempts to convert the passed curve to a circle.
  asiAlgo_EXPORT static Handle(Geom_Curve)
    ConvertToCircle(const Handle(Geom_Curve)& curve,
                    const double              tol,
                    const double              c1,
                    const double              c2,
                    double&                   cf,
                    double&                   cl,
                    double&                   deviation);

  //! Attempts to convert the passed curve to a straight line.
  asiAlgo_EXPORT static Handle(Geom_Line)
    ConvertToLine(const Handle(Geom_Curve)& curve,
                  const double              tolerance,
                  const double              c1,
                  const double              c2,
                  double&                   cf,
                  double&                   cl,
                  double&                   deviation);

  //! Constructs a line from the given two points and a parameter where
  //! to set the origin point. The parameters `cf` and `cl` will contain
  //! the parameters of `P1` and `P2` points on the constructed line.
  asiAlgo_EXPORT static gp_Lin
    ConstructLine(const gp_Pnt& P1,
                  const gp_Pnt& P2,
                  const double  c1,
                  double&       cf,
                  double&       cl);

  //! Constructs a circle for the given three points.
  asiAlgo_EXPORT static bool
    ConstructCircle(const gp_Pnt& P0,
                    const gp_Pnt& P1,
                    const gp_Pnt& P2,
                    const double  d0,
                    const double  d1,
                    const double  eps,
                    gp_Circ&      circ);

public:

  //! Complete ctor.
  asiAlgo_EXPORT
    asiAlgo_ConvertCanonicalCurve(const Handle(Geom_Curve)& C);

public:

  //! Attempts to convert this curve to a canonical form.
  asiAlgo_EXPORT bool
    Perform(const double        tol,
            Handle(Geom_Curve)& resultCurve,
            const double        F,
            const double        L,
            double&             newF,
            double&             newL);

private:

  Handle(Geom_Curve) m_curve; //!< The curve to process.

};

#endif
