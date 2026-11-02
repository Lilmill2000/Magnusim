//-----------------------------------------------------------------------------
// Created on: 10 August 2022
//-----------------------------------------------------------------------------
// Copyright (c) 2017-present, Sergey Slyadnev
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

#ifndef asiAlgo_RelievePointCloud_h
#define asiAlgo_RelievePointCloud_h

// asiAlgo includes
#include <asiAlgo_BaseCloud.h>

// OpenCascade includes
#include <gp_Ax1.hxx>

//-----------------------------------------------------------------------------

//! \ingroup ASI_MODELING
//!
//! Relieves point clouds.
class asiAlgo_RelievePointCloud
{
public:

  //! Default constructor.
  asiAlgo_EXPORT
    asiAlgo_RelievePointCloud();

public:

  //! Sparses the passed point cloud.
  //! \param[in] pc  the point cloud to thin out.
  //! \param[in] tol the spatial tolerance to use.
  //! \return the sparsed point cloud.
  asiAlgo_EXPORT Handle(asiAlgo_BaseCloud<double>)
    operator()(const Handle(asiAlgo_BaseCloud<double>)& pc,
               const double                             tol) const;

  //! Sparses the passed point cloud.
  //! \param[in]  pc  the point cloud to thin out.
  //! \param[in]  tol the spatial tolerance to use.
  //! \param[out] res the sparsed point cloud over triangles.
  asiAlgo_EXPORT void
    operator()(const std::vector< std::pair<int, gp_Ax1> >& pc,
               const double                                 tol,
               std::vector< std::pair<int, gp_Ax1> >&       res) const;

};

#endif
