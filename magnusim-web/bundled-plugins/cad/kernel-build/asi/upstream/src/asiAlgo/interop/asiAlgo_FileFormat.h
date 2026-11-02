//-----------------------------------------------------------------------------
// Created on: 29 December 2017
//-----------------------------------------------------------------------------
// Copyright (c) 2017, Sergey Slyadnev
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

#ifndef asiAlgo_FileFormat_h
#define asiAlgo_FileFormat_h

// asiAlgo includes
#include <asiAlgo.h>

// OCCT includes
#include <NCollection_IndexedMap.hxx>
#include <TCollection_AsciiString.hxx>

// Standard includes
#include <cstring>

//-----------------------------------------------------------------------------

//! \ingroup ASI_INTEROP
//!
//! Supported file types.
enum asiAlgo_FileFormat
{
  FileFormat_Unknown = 0, //!< Unknown file format.

  //---------------------------------------------------------------------------
  // Native
  //---------------------------------------------------------------------------
  FileFormat_NATIVE, //!< Native project format.
  FileFormat_XBF,    //!< OpenCascade's native for assemblies.

  //---------------------------------------------------------------------------
  // CAD
  //---------------------------------------------------------------------------
  FileFormat_BREP,
  FileFormat_STEP,
  FileFormat_IGES,
  FileFormat_DXF,

  //---------------------------------------------------------------------------
  // CAD Proprietary
  //---------------------------------------------------------------------------
  FileFormat_SOLIDWORKS,
  FileFormat_CREOVIEW,
  FileFormat_SOLIDEDGE,
  FileFormat_INVENTOR,

  //---------------------------------------------------------------------------
  // Mesh
  //---------------------------------------------------------------------------
  FileFormat_STL,
  FileFormat_PLY,
  FileFormat_OBJ,

  //---------------------------------------------------------------------------
  // Others
  //---------------------------------------------------------------------------
  FileFormat_XML,
  FileFormat_JSON,

  //---------------------------------------------------------------------------
  // Last item
  //---------------------------------------------------------------------------
  FileFormat_Last //!< Last item for convenient iteration over enum.
};

//! \ingroup ASI_INTEROP
//!
//! Utility for recognizing CAD data formats and filtering out
//! unavailable converters.
class asiAlgo_FileFormatTool
{
public:

  //! Ctor accepting the application-specific extension for native formats.
  //! \param[in] nativeExt extension for native (project) files.
  asiAlgo_FileFormatTool(const char* nativeExt) : m_nativeExt(nativeExt) {}

public:

  //! Returns file extension from the name in lower case.
  //! \param[in] path full filename.
  //! \return file extension.
  asiAlgo_EXPORT static TCollection_AsciiString
    GetFileExtension(const TCollection_AsciiString& path);

public:

  //! Returns file format analyzing the file extension.
  //! \param[in] path full filename.
  //! \return file format enum.
  asiAlgo_EXPORT static asiAlgo_FileFormat
    FormatFromFileExtension(const TCollection_AsciiString& path);

  //! Returns file format analyzing the file extension.
  //! \param[in] path full filename.
  //! \return file format enum.
  asiAlgo_EXPORT static asiAlgo_FileFormat
    FormatFromFileExtension(const std::string& path);

  //! Returns file format analyzing the file contents.
  //! \param[in] path full filename.
  //! \return file format enum.
  asiAlgo_EXPORT static asiAlgo_FileFormat
    FormatFromFileContent(const TCollection_AsciiString& path);

  //! Returns file format analyzing the file contents.
  //! \param[in] path full filename.
  //! \return file format enum.
  asiAlgo_EXPORT static asiAlgo_FileFormat
    FormatFromFileContent(const std::string& path);

public:

  //! Returns true if the passed CAD data format can be exported.
  //! \param[in] format data format in question.
  //! \return true/false.
  asiAlgo_EXPORT static bool
    IsExportSupported(const asiAlgo_FileFormat& format);

  //! Returns true if the passed CAD data format can be imported.
  //! \param[in] format data format in question.
  //! \return true/false.
  asiAlgo_EXPORT static bool
    IsImportSupported(const asiAlgo_FileFormat& format);

  //! Returns true if the passed file format is a mesh one.
  //! \param[in] fileFormat the file format to check.
  asiAlgo_EXPORT static bool
    IsMeshFormat(const asiAlgo_FileFormat& fileFormat);

protected:

  const char* m_nativeExt; //!< Extension for files in native format.

};

#endif
